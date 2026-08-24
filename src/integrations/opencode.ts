import {
  createOpencodeClient,
  type AssistantMessage,
  type Event,
  type FilePartInput,
  type OpencodeClient as SdkClient,
  type Part,
  type TextPartInput,
} from "@opencode-ai/sdk";
import { log } from "../log.js";

export interface OpencodeClientOptions {
  baseUrl: string;
  authHeader: string;
  modelProvider: string;
  modelId: string;
}

export interface OpencodeMediaAttachment {
  mimetype: string;
  dataBase64: string;
  filename?: string;
}

export interface OpencodeSendOptions {
  // The triggering message's own attachment, plus (for group messages) any
  // recent-history media forwarded alongside it — each becomes its own file part.
  media?: OpencodeMediaAttachment[];
  // Plain-language context (who's messaging, over what channel, etc.) kept
  // separate from the user's own message text — passed straight through to
  // the SDK's per-request `system` field.
  system?: string;
  // Called after a stale session is replaced and before the retry prompt is sent.
  onSessionReplaced?: (sessionId: string) => Promise<void>;
}

// Every error variant has a `name`; only some also have a string `data.message`
// (MessageOutputLengthError's `data` is an untyped bag) — narrow explicitly
// rather than assume the shape.
function errorMessage(error: NonNullable<AssistantMessage["error"]>): string {
  const data: unknown = error.data;
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message;
  }
  return error.name;
}

function joinTexts(texts: string[]): string {
  return texts.filter(Boolean).join("\n").trim();
}

function extractReplyText(parts: Part[]): string {
  return joinTexts(
    parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text").map((p) => p.text),
  );
}
interface MessagePartDeltaEvent {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
}

function isMessagePartDeltaEvent(event: unknown): event is MessagePartDeltaEvent {
  if (!event || typeof event !== "object") return false;
  const candidate = event as { type?: unknown; properties?: unknown };
  if (candidate.type !== "message.part.delta" || !candidate.properties || typeof candidate.properties !== "object") {
    return false;
  }
  const properties = candidate.properties as Record<string, unknown>;
  return (
    typeof properties.sessionID === "string" &&
    typeof properties.messageID === "string" &&
    typeof properties.partID === "string" &&
    typeof properties.field === "string" &&
    typeof properties.delta === "string"
  );
}

const BACKGROUND_TASK_PROGRESS_MARKERS = [
  "[BACKGROUND TASK RESULT READY]",
  "[BACKGROUND TASK RETRYING]",
  "[BACKGROUND TASK RETRY SESSION READY]",
] as const;
const BACKGROUND_TASK_COMPLETE_MARKER = "[ALL BACKGROUND TASKS COMPLETE]";

function backgroundWorkState(text: string): boolean | undefined {
  const normalized = text.trim();
  if (normalized.startsWith(BACKGROUND_TASK_COMPLETE_MARKER)) return false;
  if (BACKGROUND_TASK_PROGRESS_MARKERS.some((marker) => normalized.startsWith(marker))) return true;
  return undefined;
}

// The current OpenCode server emits server.connected as the first SSE event.
// The SDK creates the async stream lazily, so readiness is resolved from the
// actual stream callback rather than from a separate probe request.
export const SSE_CONNECT_TIMEOUT_MS = 30_000;

// How long to keep watching a session after its last activity before
// treating the exchange as settled — chosen after live-testing a real
// multi-round background-task exchange (individual round durations of 1m5s
// and 1m42s, including one rate-limit retry), so this comfortably clears the
// observed worst case. This is the mechanism that actually scales to a
// session of any length: it resets on every event, so a session genuinely
// still working — background tasks can legitimately run for hours — keeps
// getting watched for as long as it keeps producing activity, with no
// artificial duration cap.
export const IDLE_GRACE_MS = 4 * 60_000;
// A true backstop, not a normal-operation cutoff — only fires if a session
// somehow produces zero activity of any kind (no idle, no status, nothing)
// for this entire span, which the quiet timer above would already have
// caught long before. Generous on purpose so it can never be the thing that
// cuts off a real, still-working exchange; it only exists to bound a
// genuinely stuck/leaked connection.
export const MAX_WAIT_MS = 6 * 60 * 60_000;

export interface OpencodeSessionWatch {
  // Resolves once the session has gone quiet (or the hard ceiling is hit).
  // Only governs how long to keep watching/typing — delivery already
  // happened via onMessage as each turn completed. Declared as function-type
  // properties, not method shorthand — these are plain closures with no
  // `this` binding, and method shorthand makes eslint's unbound-method rule
  // flag them as unsafe to destructure even though they aren't.
  awaitIdle: () => Promise<void>;
  // Holds the watcher open while a prompt's HTTP request is in flight.
  // Returns undefined when the watcher has already settled.
  acquirePrompt: (chatId: string) => (() => void) | undefined;
  stop: () => void;
}

export class OpencodeClient {
  private readonly client: SdkClient;
  private readonly authHeader: string;
  private readonly modelProvider: string;
  private readonly modelId: string;

  constructor(options: OpencodeClientOptions) {
    this.authHeader = options.authHeader;
    this.modelProvider = options.modelProvider;
    this.modelId = options.modelId;
    this.client = createOpencodeClient({
      baseUrl: options.baseUrl,
      headers: this.authHeader ? { Authorization: this.authHeader } : undefined,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.authHeader);
  }

  async createSession(): Promise<string> {
    const { data, response } = await this.client.session.create({});
    if (!data) throw new Error(`session create failed: ${String(response.status)}`);
    return data.id;
  }

  private promptMessage(sessionId: string, text: string, options: OpencodeSendOptions) {
    const { media, system } = options;
    const parts: (TextPartInput | FilePartInput)[] = [];
    if (text) parts.push({ type: "text", text });
    for (const item of media ?? []) {
      parts.push({
        type: "file",
        mime: item.mimetype,
        filename: item.filename,
        url: `data:${item.mimetype};base64,${item.dataBase64}`,
      });
    }
    return this.client.session.prompt({
      path: { id: sessionId },
      body: {
        parts,
        ...(system ? { system } : {}),
        ...(this.modelProvider && this.modelId
          ? { model: { providerID: this.modelProvider, modelID: this.modelId } }
          : {}),
      },
    });
  }

  // Sends text (and optionally one media attachment, e.g. an image/document
  // forwarded from WhatsApp, and/or system-level context) to an existing
  // session; if the session is stale (404 — e.g. the opencode server
  // restarted / db reset), creates a fresh one and retries once. Returns the
  // session id actually used, so the caller can persist it if it changed, and
  // the assistant message's id — callers that also watchSession() the same
  // session concurrently need it to dedupe against this same turn (see
  // watchSession's own doc comment for why that's needed).
  async send(
    sessionId: string,
    text: string,
    options: OpencodeSendOptions = {},
  ): Promise<{ sessionId: string; reply: string; messageId: string }> {
    let currentSessionId = sessionId;
    let result = await this.promptMessage(currentSessionId, text, options);

    if (result.response.status === 404) {
      currentSessionId = await this.createSession();
      await options.onSessionReplaced?.(currentSessionId);
      result = await this.promptMessage(currentSessionId, text, options);
    }

    if (!result.data) {
      throw new Error(`opencode message send failed: ${String(result.response.status)}`);
    }

    const { info, parts } = result.data;
    if (info.error) {
      const errMsg = errorMessage(info.error);
      log("opencode agent error", errMsg);
      return { sessionId: currentSessionId, reply: `Agent error: ${errMsg}`, messageId: info.id };
    }

    const reply = extractReplyText(parts);
    return { sessionId: currentSessionId, reply: reply || "(no output)", messageId: info.id };
  }

  // Watches a session for completed turns, delivering each one via onMessage
  // as it happens. It is started before send() so a single prompt's internal
  // multi-step loop cannot lose intermediate turns. The message id lets the
  // caller dedupe the same turn observed by both the SSE stream and send().
  // One request-scoped SSE watch is opened for each active exchange; the
  // router-level AgentExchangeManager ensures concurrent prompts for one
  // sender reuse that watch instead of creating duplicate deliveries.
  // Delivery fires on any completed assistant turn (any truthy `finish`, not
  // just "stop").
  async watchSession(
    sessionId: string,
    onMessage: (messageId: string, text: string, chatId?: string) => void,
  ): Promise<OpencodeSessionWatch> {
    const controller = new AbortController();
    // messageId -> partId -> latest text. Full part updates replace the
    // current value; delta events append to the current value.
    const partsByMessage = new Map<string, Map<string, string>>();
    const pendingPrompts: { chatId: string; active: boolean }[] = [];
    const chatByMessage = new Map<string, string>();
    let fallbackChatId: string | undefined;
    let backgroundChatId: string | undefined;
    let quietTimer: ReturnType<typeof setTimeout>;
    let idleCandidateTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveIdle: () => void;
    let resolveConnection!: () => void;
    let rejectConnection!: (error: unknown) => void;
    const connectionErrorState = { hadError: false, attempts: 0 };
    let hasCompletedAssistantTurn = false;
    let sessionBusy = false;
    let backgroundWorkPending = false;
    let promptLeases = 0;
    let connected = false;
    const connectionPromise = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    const idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    const settle = (reason: string): void => {
      if (controller.signal.aborted) return;
      clearTimeout(quietTimer);
      clearTimeout(ceilingTimer);
      clearTimeout(idleCandidateTimer);
      clearTimeout(connectionTimer);
      connectionTimer = undefined;
      if (reason) log("watchSession", reason);
      controller.abort();
      resolveIdle();
    };

    const ceilingTimer = setTimeout(() => {
      settle("hit max wait ceiling");
    }, MAX_WAIT_MS);

    const resetQuietTimer = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (sessionBusy || backgroundWorkPending || promptLeases > 0 || !hasCompletedAssistantTurn) {
          resetQuietTimer();
          return;
        }
        settle("quiet with no activity for the grace window");
      }, IDLE_GRACE_MS);
    };

    const scheduleIdleSettle = (): void => {
      if (sessionBusy || backgroundWorkPending || promptLeases > 0 || !hasCompletedAssistantTurn) return;
      clearTimeout(idleCandidateTimer);
      // Give the background-task plugin a short window to inject its status
      // marker after an idle event. Plain one-turn exchanges then release
      // their watcher promptly instead of waiting IDLE_GRACE_MS.
      idleCandidateTimer = setTimeout(() => {
        if (!sessionBusy && !backgroundWorkPending && promptLeases === 0 && hasCompletedAssistantTurn) {
          settle("session idle");
        }
      }, 1_000);
    };

    resetQuietTimer();
    connectionTimer = setTimeout(() => {
      const error = new Error("SSE connection timed out");
      rejectConnection(error);
      settle("SSE connection setup timed out");
    }, SSE_CONNECT_TIMEOUT_MS);

    const markConnected = (): void => {
      if (connected) return;
      connected = true;
      clearTimeout(connectionTimer);
      connectionTimer = undefined;
      resolveConnection();
    };

    // event.subscribe() returns a lazy async stream. The current server emits
    // server.connected as its first event, and the SDK callback fires only
    // once the actual SSE request has produced an event.
    let subscribeResult: Awaited<ReturnType<SdkClient["event"]["subscribe"]>>;
    try {
      subscribeResult = await this.client.event.subscribe({
        signal: controller.signal,
        sseMaxRetryAttempts: 3,
        onSseEvent: () => {
          markConnected();
        },
        onSseError: (err) => {
          connectionErrorState.hadError = true;
          connectionErrorState.attempts += 1;
          log("watchSession SSE connect attempt failed, retrying", err instanceof Error ? err.message : String(err));
        },
      });
    } catch (err) {
      settle("SSE subscription setup failed");
      clearTimeout(ceilingTimer);
      throw err;
    }

    const { stream } = subscribeResult;
    void (async () => {
      try {
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          markConnected();
          const rawEvent = event as unknown as Event | MessagePartDeltaEvent;
          let relevant = false;

          if (isMessagePartDeltaEvent(rawEvent)) {
            const { properties } = rawEvent;
            if (properties.sessionID === sessionId) {
              relevant = true;
              if (properties.field === "text") {
                let byPart = partsByMessage.get(properties.messageID);
                if (!byPart) {
                  byPart = new Map();
                  partsByMessage.set(properties.messageID, byPart);
                }
                byPart.set(
                  properties.partID,
                  `${byPart.get(properties.partID) ?? ""}${properties.delta}`,
                );
              } else {
                sessionBusy = true;
              }
            }
          } else {
            const typedEvent = rawEvent;
            switch (typedEvent.type) {
              case "message.part.updated": {
                const { part } = typedEvent.properties;
                if (part.sessionID !== sessionId) break;
                relevant = true;
                if (part.type !== "text") sessionBusy = true;
                let byPart = partsByMessage.get(part.messageID);
                if (!byPart) {
                  byPart = new Map();
                  partsByMessage.set(part.messageID, byPart);
                }
                if (part.type === "text") byPart.set(part.id, part.text);
                break;
              }
              case "message.updated": {
                const { info } = typedEvent.properties;
                if (info.sessionID !== sessionId) break;
                relevant = true;
                const byPart = partsByMessage.get(info.id);
                const text = byPart ? joinTexts([...byPart.values()]) : "";
                partsByMessage.delete(info.id);

                if (info.role === "user") {
                  const pendingPrompt = pendingPrompts.shift();
                  const promptChatId = pendingPrompt?.chatId;
                  if (pendingPrompt) pendingPrompt.active = false;
                  if (promptChatId) {
                    chatByMessage.set(info.id, promptChatId);
                    fallbackChatId = promptChatId;
                  }
                  const isRouterPrompt = info.system?.startsWith("You are being reached over WhatsApp.") === true;
                  const backgroundState = isRouterPrompt ? undefined : backgroundWorkState(text);
                  if (backgroundState !== undefined) {
                    const destinationChatId = backgroundChatId ?? fallbackChatId;
                    if (destinationChatId) chatByMessage.set(info.id, destinationChatId);
                    backgroundWorkPending = backgroundState;
                    if (backgroundState) {
                      backgroundChatId ??= destinationChatId;
                    } else {
                      backgroundChatId = undefined;
                    }
                  }
                }
                if (info.role === "assistant") {
                  const destinationChatId = info.parentID ? chatByMessage.get(info.parentID) : undefined;
                  if (destinationChatId) chatByMessage.set(info.id, destinationChatId);
                  if (info.finish) {
                    hasCompletedAssistantTurn = true;
                    const reply = info.error ? `Agent error: ${errorMessage(info.error)}` : text;
                    if (reply) {
                      if (destinationChatId) onMessage(info.id, reply, destinationChatId);
                      else onMessage(info.id, reply);
                    }
                    scheduleIdleSettle();
                  }
                }
                break;
              }
              case "session.idle":
              case "session.status": {
                if (typedEvent.properties.sessionID !== sessionId) break;
                relevant = true;
                if (typedEvent.type === "session.status") {
                  sessionBusy = typedEvent.properties.status.type !== "idle";
                } else {
                  sessionBusy = false;
                }
                scheduleIdleSettle();
                break;
              }
              default:
                break;
            }
          }
          if (relevant) resetQuietTimer();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          log("watchSession stream error", err instanceof Error ? err.message : String(err));
        }
      } finally {
        rejectConnection(new Error("SSE stream ended before connection"));
        if (!controller.signal.aborted && connectionErrorState.hadError) {
          log(
            "watchSession stream ended after connection retries were exhausted — " +
              "may not reflect the session actually being done",
          );
        }
        if (!controller.signal.aborted) settle("SSE stream ended");
      }
    })();

    try {
      await connectionPromise;
    } catch (err) {
      settle("SSE connection failed");
      clearTimeout(ceilingTimer);
      throw err;
    }
    const acquirePrompt = (chatId: string): (() => void) | undefined => {
      if (controller.signal.aborted) return undefined;
      const pendingPrompt = { chatId, active: true };
      pendingPrompts.push(pendingPrompt);
      promptLeases += 1;
      clearTimeout(idleCandidateTimer);
      resetQuietTimer();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (pendingPrompt.active) {
          const index = pendingPrompts.indexOf(pendingPrompt);
          if (index >= 0) pendingPrompts.splice(index, 1);
          pendingPrompt.active = false;
        }
        promptLeases -= 1;
        if (controller.signal.aborted) return;
        scheduleIdleSettle();
        resetQuietTimer();
      };
    };

    return {
      awaitIdle: () => idlePromise,
      acquirePrompt,
      stop: () => {
        settle("");
      },
    };
  }
}
