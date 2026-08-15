import type { OpencodeClient, OpencodeMediaAttachment } from "./integrations/opencode.js";
import { log } from "./log.js";
import { markdownToWhatsapp } from "./markdownToWhatsapp.js";
import type { SenderLock } from "./senderLock.js";
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
}

// The agent's own reply is LLM-generated Markdown — WhatsApp uses a
// different, much smaller formatting syntax (see markdownToWhatsapp.ts).
function deliver(deps: RouterDeps, chatId: string, text: string): Promise<void> {
  return deps.typing.send(chatId, markdownToWhatsapp(text));
}

// Delivers directly to WhatsApp as each turn completes rather than returning
// text for the caller to send — a single exchange can now produce more than
// one message over several minutes (background tasks), which a single
// return value can't represent. Returns null always; routeMessage's return
// type stays string | null to cover the few synchronous early-return cases
// that don't go through here.
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
  try {
    await deps.senderLock.run(senderKey, async () => {
      let sessionId = deps.sessions.get(senderKey);
      if (!sessionId) {
        sessionId = await deps.opencode.createSession();
        deps.sessions.set(senderKey, sessionId);
      }
      deps.typing.begin(chatId);
      try {
        // Watching starts *before* send() rather than after: confirmed live
        // that a single send() call can internally produce several completed
        // turns with real user-facing text (a multi-step agentic loop) before
        // its own HTTP response resolves — watching only after would silently
        // drop all but the last one. That overlap means the watch can observe
        // the exact same turn send() itself returns, so delivery is deduped
        // by message id below.
        const delivered = new Set<string>();
        const onTurn = (messageId: string, turnText: string): void => {
          if (delivered.has(messageId)) return;
          delivered.add(messageId);
          void deliver(deps, chatId, turnText);
        };
        let watch = deps.opencode.watchSession(sessionId, onTurn);
        try {
          const result = await deps.opencode.send(sessionId, text, {
            media: extras.media,
            system: extras.context ? formatSystemContext(extras.context) : undefined,
          });
          if (result.sessionId !== sessionId) {
            // A stale (404) session was recreated inside send() — the old
            // watch was on a session that no longer exists server-side, so
            // stopping it loses nothing; restart on the real id. Anything the
            // retried prompt produced internally before this point is the one
            // known gap this doesn't cover (rare: only after an opencode
            // server restart/db reset), same as before this change.
            watch.stop();
            deps.sessions.set(senderKey, result.sessionId);
            sessionId = result.sessionId;
            watch = deps.opencode.watchSession(sessionId, onTurn);
          }
          onTurn(result.messageId, result.reply);
          await watch.awaitIdle();
        } finally {
          // Idempotent (stop() is a no-op once already settled), so this is
          // safe to call again even when the try block already stopped and
          // replaced `watch` above, or when send() itself threw before
          // awaitIdle() ever ran.
          watch.stop();
        }
      } finally {
        await deps.typing.end(chatId);
      }
    });
  } catch (err) {
    log("opencode call failed", err instanceof Error ? err.message : String(err));
    // Any error here happens either before begin() was ever called, or after
    // the inner finally's end() already ran — either way typing.send() below
    // sees this chat as inactive and won't resume its refresh interval.
    await deps.typing.send(chatId, "Agent call failed — check whatsapp-router logs.");
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
    deps.sessions.reset(senderKey);
    const rest = (newMatch[1] ?? "").trim();
    if (!rest && !hasMedia(extras) && !extras.context?.locationText) {
      return "Started a new conversation.";
    }
    return handleAgent(deps, senderKey, chatId, rest, extras);
  }

  return handleAgent(deps, senderKey, chatId, trimmed, extras);
}
