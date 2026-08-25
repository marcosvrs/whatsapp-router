import {
  OpencodeSendError,
  type OpencodeClient,
  type OpencodeMediaAttachment,
  type OpencodeSendResult,
  type OpencodeSessionWatch,
} from "./integrations/opencode.js";
import { debug, error, warn } from "./log.js";
import { markdownToWhatsapp } from "./markdownToWhatsapp.js";
import type { SenderLock } from "./senderLock.js";
import type { DeliveryRetryStore } from "./deliveryRetryStore.js";
import type { SessionStore } from "./sessionStore.js";
import type { TypingPresence } from "./waha/typingKeepAlive.js";

// Everything server.ts can tell the agent about who/where/how it's being
// reached, kept separate from the WhatsApp-domain-agnostic OpencodeClient —
// router.ts is the layer that knows both "WhatsApp" and "opencode".
export interface AgentContext {
  senderName?: string;
  senderPhone: string;
  isGroupChat: boolean;
  groupName?: string;
  timestamp?: number;
  replyToText?: string;
  locationText?: string;
  // Recent group chatter since the bot's last mention — see
  // waha/payload.ts's formatRecentMessages/trimSinceLastMention.
  recentMessages?: string;
}

export interface RouteExtras {
  media?: OpencodeMediaAttachment[];
  context?: AgentContext;
  typingStarted?: boolean;
}

function hasMedia(extras: RouteExtras): boolean {
  return Boolean(extras.media && extras.media.length > 0);
}

function formatSystemContext(context: AgentContext): string {
  const lines = ["You are being reached over WhatsApp."];
  lines.push(
    `Message from: ${context.senderName ? `${context.senderName} (+${context.senderPhone})` : `+${context.senderPhone}`}`,
  );
  lines.push(
    context.isGroupChat
      ? `Chat: a group${context.groupName ? ` named "${context.groupName}"` : ""}`
      : "Chat: a direct message (not a group)",
  );
  if (context.timestamp) {
    lines.push(`Sent at: ${new Date(context.timestamp * 1000).toISOString()}`);
  }
  if (context.replyToText) {
    lines.push(`Replying to an earlier message: "${context.replyToText}"`);
  }
  if (context.locationText) {
    lines.push(`Shared location: ${context.locationText}`);
  }
  if (context.recentMessages) {
    lines.push(`Recent messages in this group (oldest first):\n${context.recentMessages}`);
  }
  return lines.join("\n");
}

// A concrete class, not an interface (unlike ServerDeps in server.ts): tests
// construct a real OpencodeClient instance and stub its one dependency
// (global fetch) instead, since it has no state worth faking and TS
// structural typing can't match a class type against a hand-rolled fake
// with private fields. TypingPresence is a small adapter-side helper on the
// same footing — one real dependency (WahaClientLike), trivially fakeable
// without an interface of its own.
export interface RouterDeps {
  opencode: OpencodeClient;
  sessions: SessionStore;
  senderLock: SenderLock;
  typing: TypingPresence;
  exchanges: AgentExchangeManager;
  deliveryRetries: DeliveryRetryStore;
}

// Keeps one SSE watch per sender/session while allowing the sender lock to be
// released as soon as the current prompt has produced its HTTP result. A
// background exchange must not block a later inbound message for minutes, and
// multiple prompts must not create duplicate watchers that deliver the same
// turn twice.
export interface ActiveAgentExchange {
  readonly sessionId: string;
  reusable?: boolean;
  readonly isLive?: boolean;
  readonly done: Promise<void>;
  acquirePrompt: (chatId: string) => ((cancel?: boolean, userMessageId?: string) => void) | undefined;
  awaitChatIdle?: (chatId: string) => Promise<void>;
  awaitTurn?: (messageId: string) => Promise<void>;
  markPromptCompleted: (chatId?: string, mayHaveBackgroundWork?: boolean) => void;
  deliver: (messageId: string, text: string, chatId: string) => void;
  stop: () => void;
}

interface PendingDelivery {
  text: string;
  chatId: string;
  attempts: number;
  fallback?: PendingDelivery;
}
const MAX_DELIVERY_ATTEMPTS = 2;

export class AgentExchangeManager {
  private readonly active = new Map<string, ActiveAgentExchange>();
  private readonly generations = new Map<string, number>();

  async acquire(
    deps: RouterDeps,
    senderKey: string,
    sessionId: string,
    chatId: string,
  ): Promise<{
    exchange: ActiveAgentExchange;
    created: boolean;
    release: (cancel?: boolean, userMessageId?: string) => void;
  }> {
    const current = this.active.get(senderKey);
    const generation = this.currentGeneration(senderKey);
    if (current?.sessionId === sessionId && current.reusable !== false) {
      const release = current.acquirePrompt(chatId);
      if (release) return { exchange: current, created: false, release };
    }
    current?.stop();

    const delivered = new Set<string>();
    const inFlight = new Map<string, PendingDelivery>();
    const enqueueDelivery = (
      messageId: string,
      text: string,
      destinationChatId: string,
      attempts = 0,
    ): void => {
      if (generation !== this.currentGeneration(senderKey)) return;
      if (delivered.has(messageId)) return;
      const pending = inFlight.get(messageId);
      if (pending) {
        pending.fallback = { text, chatId: destinationChatId, attempts: pending.attempts };
        deps.deliveryRetries.set({
          senderKey,
          messageId,
          text,
          chatId: destinationChatId,
          attempts: pending.attempts,
        });
        return;
      }
      const delivery: PendingDelivery = { text, chatId: destinationChatId, attempts };
      deps.deliveryRetries.set({ senderKey, messageId, text, chatId: destinationChatId, attempts });
      debug("agent turn delivery queued", messageId, destinationChatId);
      inFlight.set(messageId, delivery);
      void deliver(deps, destinationChatId, text, messageId)
        .then(() => {
          inFlight.delete(messageId);
          delivered.add(messageId);
          deps.deliveryRetries.delete(senderKey, messageId);
          debug("agent turn delivered", messageId, destinationChatId);
        })
        .catch((err: unknown) => {
          inFlight.delete(messageId);
          error("failed to deliver agent turn", err instanceof Error ? err.message : String(err));
          const fallback: PendingDelivery = delivery.fallback ?? delivery;
          if (delivery.attempts + 1 < MAX_DELIVERY_ATTEMPTS) {
            warn("retrying agent turn delivery", messageId);
            enqueueDelivery(messageId, fallback.text, fallback.chatId, delivery.attempts + 1);
          } else {
            deps.deliveryRetries.delete(senderKey, messageId);
            error("agent turn delivery retries exhausted", messageId);
          }
        });
    };
    const onTurn = (messageId: string, turnText: string, turnChatId?: string): void => {
      if (!turnChatId) {
        warn("discarding unmapped agent turn", messageId);
        return;
      }
      enqueueDelivery(messageId, turnText, turnChatId);
    };
    const watch = await watchOrNoop(deps, sessionId, onTurn);
    const exchangeRef: { current: ActiveAgentExchange | undefined } = { current: undefined };
    const done = watch.awaitIdle().finally(() => {
      if (this.active.get(senderKey) === exchangeRef.current) this.active.delete(senderKey);
      watch.stop();
    });
    const exchange: ActiveAgentExchange = {
      sessionId,
      isLive: watch.isLive,
      reusable: true,
      done,
      acquirePrompt: (nextChatId) => watch.acquirePrompt(nextChatId),
      awaitChatIdle: watch.awaitChatIdle,
      awaitTurn: watch.awaitTurn,
      markPromptCompleted: (nextChatId, mayHaveBackgroundWork) => {
        watch.markPromptCompleted(nextChatId, mayHaveBackgroundWork);
      },
      deliver: (messageId, text, destinationChatId) => {
        enqueueDelivery(messageId, text, destinationChatId);
      },
      stop: () => {
        watch.stop();
        if (this.active.get(senderKey) === exchange) this.active.delete(senderKey);
      },
    };
    exchangeRef.current = exchange;
    this.active.set(senderKey, exchange);
    for (const retry of deps.deliveryRetries.list(senderKey)) {
      enqueueDelivery(retry.messageId, retry.text, retry.chatId, retry.attempts);
    }
    const release = exchange.acquirePrompt(chatId) ?? (() => undefined);
    return { exchange, created: true, release };
  }

  stop(senderKey: string, expected?: ActiveAgentExchange): void {
    const current = this.active.get(senderKey);
    if (expected && current !== expected) return;
    current?.stop();
  }

  currentGeneration(senderKey: string): number {
    return this.generations.get(senderKey) ?? 0;
  }

  bumpGeneration(senderKey: string): number {
    const next = this.currentGeneration(senderKey) + 1;
    this.generations.set(senderKey, next);
    return next;
  }
}

// The agent's own reply is LLM-generated Markdown — WhatsApp uses a
// different, much smaller formatting syntax (see markdownToWhatsapp.ts).
function deliver(deps: RouterDeps, chatId: string, text: string, messageId: string): Promise<void> {
  return deps.typing.send(chatId, markdownToWhatsapp(text), messageId);
}

// watchSession() only rejects on a narrow failure — event.subscribe() unable
// to even build the request (e.g. a malformed auth header) — since real
// connectivity problems are handled inside the SDK's own bounded-retry SSE
// client instead (see watchSession's comment). Still worth degrading
// gracefully rather than failing the whole exchange over it, matching the
// same "enrichment degrades gracefully, the core request doesn't" pattern
// server.ts already uses for the recent-group-history fetch: streaming
// background-task follow-ups is an enhancement on top of send()'s own reply,
// not something worth losing that reply over.
async function watchOrNoop(
  deps: RouterDeps,
  sessionId: string,
  onTurn: (messageId: string, text: string, chatId?: string) => void,
): Promise<OpencodeSessionWatch> {
  try {
    return await deps.opencode.watchSession(sessionId, onTurn);
  } catch (err) {
    error("watchSession connect failed — continuing without live streaming", err instanceof Error ? err.message : String(err));
    return {
      isLive: false,
      awaitIdle: () => Promise.resolve(),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: () => undefined,
      stop: () => undefined,
    };
  }
}

// Delivers directly to WhatsApp as each turn completes rather than returning
// text for the caller to send. The per-sender lock covers only session
// mutation and the current prompt; the long-lived exchange watcher is awaited
// after that lock is released.
async function handleAgent(
  deps: RouterDeps,
  senderKey: string,
  chatId: string,
  text: string,
  extras: RouteExtras,
): Promise<null> {
  if (!deps.opencode.isConfigured()) {
    await deps.typing.send(chatId, "opencode agent not configured yet.");
    return null;
  }

  let exchange!: ActiveAgentExchange;
  let exchangeIsLive: boolean | undefined;
  let exchangeCreated = false;
  let waitForExchange: Promise<void> = Promise.resolve();
  let endTyping: () => Promise<void> = () => Promise.resolve();
  let promptSucceeded = false;
  let promptUserMessageId: string | undefined;
  try {
    await deps.senderLock.run(senderKey, async () => {
      let releasePrompt: (cancel?: boolean, userMessageId?: string) => void = () => undefined;
      let promptReleased = false;
      try {
        let sessionId = deps.sessions.get(senderKey);
        if (!sessionId) {
          sessionId = await deps.opencode.createSession();
          deps.sessions.set(senderKey, sessionId);
        }

        if (!extras.typingStarted) {
          deps.typing.begin(chatId);
          endTyping = () => deps.typing.end(chatId);
        }
        const acquired = await deps.exchanges.acquire(deps, senderKey, sessionId, chatId);
        exchange = acquired.exchange;
        exchangeIsLive = acquired.exchange.isLive !== false;
        exchangeCreated = acquired.created;
        waitForExchange =
          acquired.exchange.awaitChatIdle?.(chatId) ??
          (acquired.created ? acquired.exchange.done : Promise.resolve());
        releasePrompt = acquired.release;

        const replaceExchange = async (nextSessionId: string): Promise<void> => {
          releasePrompt(true);
          promptReleased = true;
          deps.exchanges.stop(senderKey, exchange);
          deps.sessions.set(senderKey, nextSessionId);
          const replacement = await deps.exchanges.acquire(deps, senderKey, nextSessionId, chatId);
          exchange = replacement.exchange;
          exchangeIsLive = replacement.exchange.isLive !== false;
          exchangeCreated = replacement.created;
          waitForExchange = replacement.exchange.awaitChatIdle?.(chatId) ?? replacement.exchange.done;
          releasePrompt = replacement.release;
          promptReleased = false;
        };
        let result: OpencodeSendResult;
        try {
          result = await deps.opencode.send(sessionId, text, {
            media: extras.media,
            system: extras.context ? formatSystemContext(extras.context) : undefined,
            onSessionReplaced: replaceExchange,
          });
        } catch (err) {
          if (err instanceof OpencodeSendError) {
            releasePrompt(true);
            promptReleased = true;
            if (exchangeCreated) deps.exchanges.stop(senderKey, exchange);
          }
          throw err;
        }
        if (result.sessionId !== exchange.sessionId) {
          await replaceExchange(result.sessionId);
        }
        promptSucceeded = true;
        promptUserMessageId = result.userMessageId;
        releasePrompt(false, promptUserMessageId);
        promptReleased = true;
        exchange.markPromptCompleted(chatId, result.mayHaveBackgroundWork);
        await exchange.awaitTurn?.(result.messageId);
        exchange.deliver(result.messageId, result.reply, chatId);
      } finally {
        if (!promptReleased) releasePrompt(false, promptSucceeded ? promptUserMessageId : undefined);
      }
    });

    // This wait is deliberately outside senderLock.run(). A background task
    // may keep typing alive for minutes, but a new inbound message must still
    // be allowed to acquire the sender's prompt lock.
    await waitForExchange;
  } catch (err) {
    const isAmbiguous = !(err instanceof OpencodeSendError) && exchangeIsLive === true;
    if (isAmbiguous) {
      exchange.reusable = false;
      warn("opencode call outcome ambiguous; live watcher retained", err instanceof Error ? err.message : String(err));
      await waitForExchange;
    } else {
      error("opencode call failed", err instanceof Error ? err.message : String(err));
      await deps.typing.send(chatId, "Agent call failed — check whatsapp-router logs.");
    }
  } finally {
    await endTyping();
  }
  return null;
}

// "/new" resets the sender's session; anything else falls through to the
// agent (which is now the only route — Home Assistant and Firefly control
// happen through opencode's own tools/MCP servers instead of dedicated
// prefixes here). Attached media (the triggering message's own attachment,
// plus — for group messages — any recent-history media forwarded alongside
// it) rides along to the agent as file parts, and context (who/where/how)
// rides along as the SDK's separate `system` field. Returns the reply text
// only for the synchronous early-return cases (e.g. a bare "/new" ack) —
// server.ts sends it when non-null. The agent path delivers directly and
// returns null.
export async function routeMessage(
  deps: RouterDeps,
  senderKey: string,
  chatId: string,
  text: string,
  extras: RouteExtras = {},
): Promise<string | null> {
  const trimmed = text.trim();
  const newMatch = /^\/new\b(.*)$/i.exec(trimmed);

  if (newMatch) {
    const rest = (newMatch[1] ?? "").trim();
    await deps.senderLock.run(senderKey, () => {
      deps.exchanges.bumpGeneration(senderKey);
      deps.exchanges.stop(senderKey);
      deps.sessions.reset(senderKey);
      return Promise.resolve();
    });
    if (!rest && !hasMedia(extras) && !extras.context?.locationText) {
      return "Started a new conversation.";
    }
    return handleAgent(deps, senderKey, chatId, rest, extras);
  }

  return handleAgent(deps, senderKey, chatId, trimmed, extras);
}
