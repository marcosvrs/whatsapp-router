import {
  createOpencodeClient,
  type AssistantMessage,
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

// How long to keep watching a session after it goes idle before treating the
// exchange as settled — chosen after live-testing a real multi-round
// background-task exchange (individual round durations of 1m5s and 1m42s,
// including one rate-limit retry), so this comfortably clears the observed
// worst case.
const IDLE_GRACE_MS = 4 * 60_000;
// Hard ceiling regardless of activity — a real end-to-end background-task run
// took ~5-6 minutes wall clock, so this leaves real margin without being
// unbounded.
const MAX_WAIT_MS = 15 * 60_000;

export interface OpencodeSessionWatch {
  // Resolves once the session has gone quiet (or the hard ceiling is hit).
  // Only governs how long to keep watching/typing — delivery already
  // happened via onMessage as each turn completed. Declared as function-type
  // properties, not method shorthand — these are plain closures with no
  // `this` binding, and method shorthand makes eslint's unbound-method rule
  // flag them as unsafe to destructure even though they aren't.
  awaitIdle: () => Promise<void>;
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
  // as it happens. Meant to be started *alongside* send() (before it, or
  // concurrently) rather than only after — confirmed live that a single
  // send() call can internally produce several completed assistant turns
  // with real user-facing text (a multi-step agentic loop) before its own
  // HTTP response finally resolves; starting the watch only after send()
  // returns would silently miss all but the last one. Because of that overlap,
  // onMessage passes the message id so the caller can dedupe against send()'s
  // own returned { messageId } — the two can observe the exact same turn.
  // Opens one SSE connection for the duration of the watch (request-scoped:
  // no registry, nothing survives past stop()/awaitIdle() resolving).
  // Delivery fires on any completed assistant turn (any truthy `finish`, not
  // just "stop" — confirmed live via an intermediate turn with
  // finish: "tool-calls" carrying real user-facing text).
  watchSession(sessionId: string, onMessage: (messageId: string, text: string) => void): OpencodeSessionWatch {
    const controller = new AbortController();
    // messageId -> partId -> latest text (message.part.updated always carries
    // the full current value, not a delta — confirmed live).
    const partsByMessage = new Map<string, Map<string, string>>();
    let quietTimer: ReturnType<typeof setTimeout>;
    let resolveIdle: () => void;
    const idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    // controller.signal.aborted (not a plain boolean flag) doubles as the
    // "have we settled" check throughout — settling always aborts, so there's
    // one source of truth, and it also closes the SSE connection immediately
    // instead of leaving it open until some later stop() call.
    const settle = (reason: string): void => {
      if (controller.signal.aborted) return;
      clearTimeout(quietTimer);
      clearTimeout(ceilingTimer);
      if (reason) log("watchSession", reason);
      controller.abort();
      resolveIdle();
    };

    const ceilingTimer = setTimeout(() => {
      settle("hit max wait ceiling");
    }, MAX_WAIT_MS);

    // Settling depends on "nothing happened for this session in
    // IDLE_GRACE_MS", not on a specific `session.idle` event — confirmed live
    // that `session.idle` reliably fires *between* background-task rounds,
    // but does not reliably fire again once a session has nothing left
    // pending at all (a real run sat fully idle for 10+ minutes after its
    // final answer with zero further events, `session.idle` included — so
    // gating settle on that event alone would have meant every such exchange
    // rides the full MAX_WAIT_MS ceiling instead of settling promptly).
    // Reset on *any* event scoped to this session, started immediately so an
    // already-quiet session (nothing pending at all) still settles.
    const resetQuietTimer = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        settle("quiet with no activity for the grace window");
      }, IDLE_GRACE_MS);
    };
    resetQuietTimer();

    void (async () => {
      try {
        const { stream } = await this.client.event.subscribe({ signal: controller.signal });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          let relevant = false;
          switch (event.type) {
            case "message.part.updated": {
              const { part } = event.properties;
              if (part.sessionID !== sessionId || part.type !== "text") break;
              relevant = true;
              let byPart = partsByMessage.get(part.messageID);
              if (!byPart) {
                byPart = new Map();
                partsByMessage.set(part.messageID, byPart);
              }
              byPart.set(part.id, part.text);
              break;
            }
            case "message.updated": {
              const { info } = event.properties;
              if (info.sessionID !== sessionId) break;
              relevant = true;
              if (info.role === "assistant" && info.finish) {
                const byPart = partsByMessage.get(info.id);
                partsByMessage.delete(info.id);
                const text = byPart ? joinTexts([...byPart.values()]) : "";
                if (text) onMessage(info.id, text);
              }
              break;
            }
            case "session.idle":
            case "session.status": {
              if (event.properties.sessionID !== sessionId) break;
              relevant = true;
              break;
            }
            default:
              break;
          }
          if (relevant) resetQuietTimer();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          log("watchSession stream error", err instanceof Error ? err.message : String(err));
        }
      } finally {
        settle("");
      }
    })();

    return {
      awaitIdle: () => idlePromise,
      stop: () => {
        settle("");
      },
    };
  }
}
