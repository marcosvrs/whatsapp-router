import {
  createOpencodeClient,
  type AssistantMessage,
  type Event,
  type FilePartInput,
  type OpencodeClient as SdkClient,
  type Part,
  type TextPartInput,
} from "@opencode-ai/sdk";
import { error, info, warn } from "../log.js";

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
export class OpencodeSendError extends Error {
  readonly status: number;

  constructor(status: number, message = `opencode message send failed: ${String(status)}`) {
    super(message);
    this.name = "OpencodeSendError";
    this.status = status;
  }
}

export interface OpencodeSendResult {
  sessionId: string;
  reply: string;
  messageId: string;
  userMessageId?: string;
  mayHaveBackgroundWork?: boolean;
}

// Every error variant has a `name`; only some also have a string `data.message`
// (MessageOutputLengthError's `data` is an untyped bag) — narrow explicitly
// rather than assume the shape.
export function errorMessage(error: NonNullable<AssistantMessage["error"]>): string {
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

export function isMessagePartDeltaEvent(event: unknown): event is MessagePartDeltaEvent {
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
interface ChatLifecycle {
  activePrompts: number;
  completedPrompts: number;
  backgroundPending: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}


const BACKGROUND_TASK_PROGRESS_MARKERS = [
  "[BACKGROUND TASK RESULT READY]",
  "[BACKGROUND TASK RETRYING]",
  "[BACKGROUND TASK RETRY SESSION READY]",
] as const;
const BACKGROUND_TASK_COMPLETE_MARKER = "[ALL BACKGROUND TASKS COMPLETE]";

export function backgroundWorkState(text: string): boolean | undefined {
  const normalized = text.trim();
  if (normalized.startsWith(BACKGROUND_TASK_COMPLETE_MARKER)) return false;
  if (BACKGROUND_TASK_PROGRESS_MARKERS.some((marker) => normalized.startsWith(marker))) return true;
  return undefined;
}
export function mayBeBackgroundMarkerPrefix(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  return (
    normalized.length > 0 &&
    [BACKGROUND_TASK_COMPLETE_MARKER, ...BACKGROUND_TASK_PROGRESS_MARKERS].some(
      (marker) => marker.startsWith(normalized) || normalized.startsWith(marker),
    )
  );
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
export const TURN_RECONCILE_MS = 100;
// A true backstop, not a normal-operation cutoff — only fires if a session
// somehow produces zero activity of any kind (no idle, no status, nothing)
// for this entire span, which the quiet timer above would already have
// caught long before. Generous on purpose so it can never be the thing that
// cuts off a real, still-working exchange; it only exists to bound a
// genuinely stuck/leaked connection.
export const MAX_WAIT_MS = 6 * 60 * 60_000;
const GLOBAL_STREAM_ENDED = Symbol("global-sse-stream-ended");

type QueueWaiter<T> = (result: IteratorResult<T>) => void;

interface EventQueue<T> extends AsyncIterable<T> {
  push: (value: T) => void;
  close: () => void;
}

export function createEventQueue<T>(): EventQueue<T> {
  const values: T[] = [];
  const waiters: QueueWaiter<T>[] = [];
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      values.push(value);
      const waiter = waiters.shift();
      if (waiter) waiter({ value: values.shift() as T, done: false });
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter) waiter({ value: undefined as T, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<T>> => {
          if (values.length > 0) return Promise.resolve({ value: values.shift() as T, done: false });
          if (closed) return Promise.resolve({ value: undefined as T, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

export function eventSessionId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const properties = (event as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return undefined;
  const candidate = properties as Record<string, unknown>;
  if (typeof candidate.sessionID === "string") return candidate.sessionID;
  for (const key of ["info", "part"]) {
    const nested = candidate[key];
    if (nested && typeof nested === "object" && typeof (nested as { sessionID?: unknown }).sessionID === "string") {
      return (nested as { sessionID: string }).sessionID;
    }
  }
  return undefined;
}

interface GlobalEventListener {
  sessionId: string;
  queue: EventQueue<unknown>;
  reconnectDelay: () => number | undefined;
}

interface GlobalEventSubscription {
  stream: AsyncIterable<unknown>;
  connected: Promise<void>;
  unsubscribe: () => void;
}

export class GlobalEventHub {
  private readonly listeners = new Set<GlobalEventListener>();
  private readonly connectionWaiters = new Map<
    GlobalEventListener,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  private controller: AbortController | undefined;
  private runPromise: Promise<void> | undefined;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;
  private hasConnectedOnce = false;

  constructor(private readonly client: SdkClient) {}

  subscribe(sessionId: string, reconnectDelay: () => number | undefined): GlobalEventSubscription {
    const listener: GlobalEventListener = { sessionId, reconnectDelay, queue: createEventQueue<unknown>() };
    this.listeners.add(listener);
    if (!this.runPromise || this.controller?.signal.aborted) {
      const controller = new AbortController();
      this.controller = controller;
      this.connected = false;
      this.hasConnectedOnce = false;
      this.connectionTimer = setTimeout(() => {
        this.failInitial(new Error("SSE connection timed out"));
      }, SSE_CONNECT_TIMEOUT_MS);
      this.runPromise = this.run(controller).finally(() => {
        /* c8 ignore next -- protects a newer hub run from an old finalizer. */
        if (this.controller !== controller) return;
        clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
        this.runPromise = undefined;
        this.controller = undefined;
        this.connected = false;
        this.hasConnectedOnce = false;
      });
    }

    const connected = this.connected
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => this.connectionWaiters.set(listener, { resolve, reject }));
    const unsubscribe = (): void => {
      const waiter = this.connectionWaiters.get(listener);
      if (waiter) {
        waiter.reject(new Error("SSE subscription canceled"));
        this.connectionWaiters.delete(listener);
      }
      if (!this.listeners.delete(listener)) return;
      listener.queue.close();
      if (this.listeners.size === 0) {
        this.controller?.abort();
        clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
      }
    };
    return { stream: listener.queue, connected, unsubscribe };
  }

  private markConnected(): void {
    if (this.connected) return;
    this.connected = true;
    this.hasConnectedOnce = true;
    clearTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
    for (const waiter of this.connectionWaiters.values()) waiter.resolve();
    this.connectionWaiters.clear();
  }

  private failInitial(errorValue: unknown): void {
    for (const waiter of this.connectionWaiters.values()) waiter.reject(errorValue);
    this.connectionWaiters.clear();
    for (const listener of this.listeners) listener.queue.close();
    this.listeners.clear();
    this.controller?.abort();
  }

  private dispatch(event: unknown): void {
    const sessionId = eventSessionId(event);
    for (const listener of this.listeners) {
      if (!sessionId || listener.sessionId === sessionId) listener.queue.push(event);
    }
  }
  private pushStreamEnded(): void {
    for (const listener of this.listeners) listener.queue.push(GLOBAL_STREAM_ENDED);
  }

  private nextReconnectDelay(): number | undefined {
    const delays = [...this.listeners]
      .map((listener) => listener.reconnectDelay())
      .filter((delay): delay is number => delay !== undefined);
    return delays.length > 0 ? Math.min(...delays) : undefined;
  }
  private async waitForReconnectable(controller: AbortController): Promise<number> {
    let delay = this.nextReconnectDelay();
    while (delay === undefined && !controller.signal.aborted && this.listeners.size > 0) {
      this.pushStreamEnded();
      await this.waitBeforeReconnect(controller, 1_000);
      delay = this.nextReconnectDelay();
    }
    return delay ?? 1_000;
  }

  private waitBeforeReconnect(controller: AbortController, delay: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      controller.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async run(controller: AbortController): Promise<void> {
    let hadSseError = false;
    const isAborted = (): boolean => controller.signal.aborted;
    const sawSseError = (): boolean => hadSseError;
      while (!isAborted() && this.listeners.size > 0) {
        let stream: AsyncIterable<unknown>;
        try {
          const result = await this.client.event.subscribe({
            signal: controller.signal,
            sseMaxRetryAttempts: 3,
            onSseEvent: () => {
              this.markConnected();
            },
            onSseError: (err) => {
              hadSseError = true;
              warn("watchSession SSE connect attempt failed, retrying", err instanceof Error ? err.message : String(err));
            },
          });
          stream = result.stream;
        } catch (err) {
          /* c8 ignore next -- abort can race an in-flight SDK subscription. */
          if (isAborted()) break;
          if (!this.hasConnectedOnce) {
            this.failInitial(err);
            return;
          }
          warn("watchSession reconnect failed, retrying", err instanceof Error ? err.message : String(err));
          await this.waitBeforeReconnect(controller, 1_000);
          continue;
        }

        try {
          for await (const event of stream) {
            if (isAborted()) break;
            this.markConnected();
            this.dispatch(event);
          }
        } catch (err) {
          if (!isAborted()) {
            error("watchSession stream error", err instanceof Error ? err.message : String(err));
          }
        }
        if (isAborted() || this.listeners.size === 0) break;
        if (!this.hasConnectedOnce) {
          this.failInitial(new Error("SSE stream ended before connection"));
          return;
        }
        this.connected = false;
        this.pushStreamEnded();
        if (sawSseError()) {
          error(
            "watchSession stream ended after connection retries were exhausted — " +
              "may not reflect the session actually being done",
          );
        }
        hadSseError = false;
        await Promise.resolve();
        let delay = await this.waitForReconnectable(controller);
        if (isAborted() || this.listeners.size === 0) break;
        await this.waitBeforeReconnect(controller, delay);
        if (isAborted() || this.listeners.size === 0) break;
        if (this.nextReconnectDelay() === undefined) {
          delay = await this.waitForReconnectable(controller);
          if (isAborted() || this.listeners.size === 0) break;
        /* c8 ignore next -- a watcher can join while an inactive hub waits. */
        await this.waitBeforeReconnect(controller, delay);
        }
  }
}


}
export interface OpencodeSessionWatch {
  // Resolves once the session has gone quiet (or the hard ceiling is hit).
  // Only governs how long to keep watching/typing — delivery already
  // happened via onMessage as each turn completed. Declared as function-type
  // properties, not method shorthand — these are plain closures with no
  // `this` binding, and method shorthand makes eslint's unbound-method rule
  // flag them as unsafe to destructure even though they aren't.
  awaitIdle: () => Promise<void>;
  // False means SSE setup failed and no live watcher retained the prompt.
  isLive?: boolean;
  awaitChatIdle?: (chatId: string) => Promise<void>;
  awaitTurn?: (messageId: string) => Promise<void>;
  // Holds the watcher open while a prompt's HTTP request is in flight.
  // Returns undefined when the watcher has already settled.
  acquirePrompt: (chatId: string) => ((cancel?: boolean, userMessageId?: string) => void) | undefined;
  // Marks the prompt HTTP result as a completed assistant turn even if SSE
  // missed its completion event.
  markPromptCompleted: (chatId?: string, mayHaveBackgroundWork?: boolean) => void;
  stop: () => void;
}

export class OpencodeClient {
  private readonly client: SdkClient;
  private readonly authHeader: string;
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly events: GlobalEventHub;

  constructor(options: OpencodeClientOptions) {
    this.authHeader = options.authHeader;
    this.modelProvider = options.modelProvider;
    this.modelId = options.modelId;
    this.client = createOpencodeClient({
      baseUrl: options.baseUrl,
      headers: this.authHeader ? { Authorization: this.authHeader } : undefined,
    });
    this.events = new GlobalEventHub(this.client);
  }

  isConfigured(): boolean {
    return Boolean(this.authHeader);
  }

  async createSession(): Promise<string> {
    const { data, response } = await this.client.session.create({});
    if (!data) {
      throw new OpencodeSendError(response.status, `session create failed: ${String(response.status)}`);
    }
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
  ): Promise<OpencodeSendResult> {
    let currentSessionId = sessionId;
    let result = await this.promptMessage(currentSessionId, text, options);

    if (result.response.status === 404) {
      currentSessionId = await this.createSession();
      await options.onSessionReplaced?.(currentSessionId);
      result = await this.promptMessage(currentSessionId, text, options);
    }

    if (!result.data) {
      throw new OpencodeSendError(result.response.status);
    }

    const { info, parts } = result.data;
    const mayHaveBackgroundWork = parts.some((part) => part.type !== "text");
    if (info.error) {
      const errMsg = errorMessage(info.error);
      warn("opencode agent error", errMsg);
      return {
        sessionId: currentSessionId,
        reply: `Agent error: ${errMsg}`,
        messageId: info.id,
        userMessageId: info.parentID,
        mayHaveBackgroundWork,
      };
    }

    const reply = extractReplyText(parts);
    return {
      sessionId: currentSessionId,
      reply: reply || "(no output)",
      messageId: info.id,
      userMessageId: info.parentID,
      mayHaveBackgroundWork,
    };
  }

  // Watches a session for completed turns, delivering each one via onMessage
  // as it happens. It is started before send() so a single prompt's internal
  // multi-step loop cannot lose intermediate turns. The message id lets the
  // caller dedupe the same turn observed by both the SSE stream and send().
  // A single global SSE subscription is shared by all active exchanges on
  // this client; the hub dispatches only session-matching events to each
  // watcher.
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
    const pendingPrompts: { chatId: string; active: boolean; userMessageId?: string }[] = [];
    const chatByMessage = new Map<string, string>();
    const userMessageMetadata = new Map<string, { system?: string; parentMessageId?: string }>();
    const processedUserMessages = new Set<string>();
    let promptMayStartBackgroundWork = false;
    const backgroundDestinations: { chatId: string; pending: boolean; userMessageId?: string }[] = [];
    const chatLifecycles = new Map<string, ChatLifecycle>();
    const seenAssistantMessages = new Set<string>();
    let assistantStreamActivity = false;
    const turnWaiters = new Map<string, Set<() => void>>();
    const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let unassignedBackgroundPending = false;
    let quietTimer: ReturnType<typeof setTimeout>;
    let idleCandidateTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveIdle: () => void;
    const unsubscribeRef: { current?: () => void } = {};
    let hasCompletedAssistantTurn = false;
    let sessionBusy = false;
    let backgroundWorkPending = false;
    let promptLeases = 0;
    let promptLeaseAcquired = false;
    let live = true;
    const idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const clearIdleCandidate = (): void => {
      clearTimeout(idleCandidateTimer);
      idleCandidateTimer = undefined;
    };
    const settle = (reason: string): void => {
      if (!promptLeaseAcquired) live = false;
      if (controller.signal.aborted) return;
      clearTimeout(quietTimer);
      clearTimeout(ceilingTimer);
      clearIdleCandidate();
      unsubscribeRef.current?.();
      for (const lifecycle of chatLifecycles.values()) {
        clearTimeout(lifecycle.idleTimer);
        for (const resolve of lifecycle.waiters) resolve();
        lifecycle.waiters.clear();
      }
      for (const timer of turnTimers.values()) clearTimeout(timer);
      turnTimers.clear();
      for (const waiters of turnWaiters.values()) {
        for (const resolve of waiters) resolve();
      }
      turnWaiters.clear();
      if (reason) info("watchSession", reason);
      controller.abort();
      resolveIdle();
    };

    let ceilingTimer!: ReturnType<typeof setTimeout>;
    const resetCeilingTimer = (): void => {
      clearTimeout(ceilingTimer);
      ceilingTimer = setTimeout(() => {
        settle("hit max wait ceiling");
      }, MAX_WAIT_MS);
    };
    resetCeilingTimer();

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
      if (sessionBusy || backgroundWorkPending || promptLeases > 0 || !hasCompletedAssistantTurn || promptMayStartBackgroundWork) return;
      clearIdleCandidate();
      // Give the background-task plugin a short window to inject its status
      // marker after an idle event. Plain one-turn exchanges then release
      // their watcher promptly instead of waiting IDLE_GRACE_MS.
      idleCandidateTimer = setTimeout(() => {
        idleCandidateTimer = undefined;
        if (!sessionBusy && !backgroundWorkPending && promptLeases === 0 && hasCompletedAssistantTurn) {
          settle("session idle");
        }
      }, 1_000);
    };

    const getChatLifecycle = (chatId: string): ChatLifecycle => {
      let lifecycle = chatLifecycles.get(chatId);
      if (!lifecycle) {
        lifecycle = { activePrompts: 0, completedPrompts: 0, backgroundPending: false, waiters: new Set() };
        chatLifecycles.set(chatId, lifecycle);
      }
      return lifecycle;
    };
    const cancelChatIdle = (chatId: string): void => {
      const lifecycle = getChatLifecycle(chatId);
      clearTimeout(lifecycle.idleTimer);
      lifecycle.idleTimer = undefined;
    };
    const rescheduleCompletedChatIdle = (): void => {
      for (const destination of backgroundDestinations) {
        scheduleChatIdle(destination.chatId);
      }
    };
    const scheduleChatIdle = (chatId: string): void => {
      const lifecycle = getChatLifecycle(chatId);
      if (lifecycle.activePrompts > 0 || lifecycle.backgroundPending || lifecycle.completedPrompts === 0) return;
      clearTimeout(lifecycle.idleTimer);
      lifecycle.idleTimer = setTimeout(() => {
        lifecycle.idleTimer = undefined;
        lifecycle.completedPrompts = 0;
        const waiters = [...lifecycle.waiters];
        lifecycle.waiters.clear();
        for (const resolve of waiters) resolve();
      }, 1_000);
    };
    const refreshChatBackground = (chatId: string): void => {
      const lifecycle = getChatLifecycle(chatId);
      lifecycle.backgroundPending = backgroundDestinations.some(
        (destination) => destination.chatId === chatId && destination.pending,
      );
      if (lifecycle.backgroundPending) clearTimeout(lifecycle.idleTimer);
      else scheduleChatIdle(chatId);
    };
    const registerPromptDestination = (chatId: string, userMessageId: string): void => {
      chatByMessage.set(userMessageId, chatId);
      if (backgroundDestinations.some((destination) => destination.userMessageId === userMessageId)) return;
      cancelChatIdle(chatId);
      backgroundDestinations.push({ chatId, pending: false, userMessageId });
    };
    const awaitChatIdle = (chatId: string): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve();
      const lifecycle = getChatLifecycle(chatId);
      return new Promise((resolve) => {
        lifecycle.waiters.add(resolve);
        scheduleChatIdle(chatId);
      });
    };
    const settleTurnWaiters = (messageId: string): void => {
      clearTimeout(turnTimers.get(messageId));
      turnTimers.delete(messageId);
      const waiters = turnWaiters.get(messageId);
      if (!waiters) return;
      turnWaiters.delete(messageId);
      for (const resolve of waiters) resolve();
    };
    const scheduleTurnReconcile = (messageId: string): void => {
      clearTimeout(turnTimers.get(messageId));
      turnTimers.set(
        messageId,
        setTimeout(() => {
          settleTurnWaiters(messageId);
        }, TURN_RECONCILE_MS),
      );
    };
    const awaitTurn = (messageId: string): Promise<void> => {
      if (controller.signal.aborted || seenAssistantMessages.has(messageId) || !assistantStreamActivity) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const waiters = turnWaiters.get(messageId) ?? new Set<() => void>();
        waiters.add(resolve);
        turnWaiters.set(messageId, waiters);
        scheduleTurnReconcile(messageId);
      });
    };
    const markAssistantSeen = (messageId: string): void => {
      seenAssistantMessages.add(messageId);
      settleTurnWaiters(messageId);
    };
    const hasTrackedWork = (): boolean =>
      sessionBusy || backgroundWorkPending || promptLeases > 0 || idleCandidateTimer !== undefined;
    resetQuietTimer();
    const processUserMessageState = (
      messageId: string,
      text: string,
      system?: string,
      parentMessageId?: string,
    ): boolean => {
      const isRouterPrompt = system?.startsWith("You are being reached over WhatsApp.") === true;
      const state = isRouterPrompt ? undefined : backgroundWorkState(text);
      const linkedChatId = parentMessageId ? chatByMessage.get(parentMessageId) : undefined;
      const linkedDestination = linkedChatId
        ? backgroundDestinations.findLast((item) => item.chatId === linkedChatId)
        : undefined;
      if (state !== undefined) {
        if (state) {
          const normalized = text.trim();
          const candidates = normalized.startsWith("[BACKGROUND TASK RETRY")
            ? backgroundDestinations.filter((item) => item.pending)
            : backgroundDestinations.filter((item) => !item.pending);
          const destination = linkedDestination ?? (candidates.length === 1 ? candidates[0] : undefined);
          if (destination) {
            destination.pending = true;
            chatByMessage.set(messageId, destination.chatId);
            refreshChatBackground(destination.chatId);
            unassignedBackgroundPending = false;
          } else {
            unassignedBackgroundPending = true;
            warn("discarding uncorrelated background progress marker", messageId);
          }
        } else {
          const candidates = backgroundDestinations.filter((item) => item.pending);
          const destination = linkedDestination ?? (candidates.length === 1 ? candidates[0] : undefined);
          if (destination) {
            destination.pending = false;
            chatByMessage.set(messageId, destination.chatId);
            backgroundDestinations.splice(backgroundDestinations.indexOf(destination), 1);
            refreshChatBackground(destination.chatId);
          } else {
            warn("discarding uncorrelated background completion marker", messageId);
            if (backgroundDestinations.length === 0) unassignedBackgroundPending = false;
          }
        }
        backgroundWorkPending = unassignedBackgroundPending || backgroundDestinations.some((item) => item.pending);
        if (!backgroundWorkPending) {
          promptMayStartBackgroundWork = false;
          scheduleIdleSettle();
        }
      }
      const markerPrefix = mayBeBackgroundMarkerPrefix(text);
      if (!text.trim()) return false;
      return isRouterPrompt || state !== undefined || !markerPrefix;
    };


    const recoverMessageText = async (messageId: string): Promise<string> => {
      try {
        const result = await this.client.session.message({
          path: { id: sessionId, messageID: messageId },
        });
        return result.data ? extractReplyText(result.data.parts) : "";
      } catch (err) {
        warn("watchSession message recovery failed", err instanceof Error ? err.message : String(err));
        return "";
      }
    };
    const isActive = (): boolean => !controller.signal.aborted;

    // The global hub owns the SSE connection and keeps this queue open across
    // reconnects. Each watcher only processes events for its own session.
    async function consume(stream: AsyncIterable<unknown>): Promise<void> {
      try {
        for await (const event of stream) {
          /* c8 ignore next -- abort can race a queued event delivery. */
          if (controller.signal.aborted) break;
          if (event === GLOBAL_STREAM_ENDED) {
            if (!hasTrackedWork()) settle("SSE stream ended");
            continue;
          }
          const rawEvent = event as Event | MessagePartDeltaEvent;
          let relevant = false;

          if (isMessagePartDeltaEvent(rawEvent)) {
            const { properties } = rawEvent;
            if (properties.sessionID === sessionId) {
              clearIdleCandidate();
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
                const metadata = userMessageMetadata.get(properties.messageID);
                if (metadata) {
                  const text = joinTexts([...byPart.values()]);
                  if (processUserMessageState(properties.messageID, text, metadata.system, metadata.parentMessageId)) {
                    rescheduleCompletedChatIdle();
                    processedUserMessages.add(properties.messageID);
                    userMessageMetadata.delete(properties.messageID);
                    partsByMessage.delete(properties.messageID);
                  }
                }
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
                clearIdleCandidate();
                relevant = true;
                if (part.type !== "text") sessionBusy = true;
                let byPart = partsByMessage.get(part.messageID);
                if (!byPart) {
                  byPart = new Map();
                  partsByMessage.set(part.messageID, byPart);
                }
                if (part.type === "text") byPart.set(part.id, part.text);
                const metadata = userMessageMetadata.get(part.messageID);
                if (metadata) {
                  const text = joinTexts([...byPart.values()]);
                  if (processUserMessageState(part.messageID, text, metadata.system, metadata.parentMessageId)) {
                    rescheduleCompletedChatIdle();
                    processedUserMessages.add(part.messageID);
                    userMessageMetadata.delete(part.messageID);
                    partsByMessage.delete(part.messageID);
                  }
                }
                break;
              }
              case "message.updated": {
                const { info } = typedEvent.properties;
                if (info.sessionID !== sessionId) break;
                clearIdleCandidate();
                relevant = true;
                const byPart = partsByMessage.get(info.id);
                const text = byPart ? joinTexts([...byPart.values()]) : "";

                if (info.role === "user") {
                  if (processedUserMessages.delete(info.id)) {
                    break;
                  }
                  const isRouterPrompt = info.system?.startsWith("You are being reached over WhatsApp.") === true;
                  for (const destination of backgroundDestinations) {
                    cancelChatIdle(destination.chatId);
                  }
                  const parentMessageId =
                    "parentID" in info && typeof info.parentID === "string" ? info.parentID : undefined;
                  userMessageMetadata.set(info.id, { system: info.system, parentMessageId });
                  if (isRouterPrompt) {
                    const pendingPrompt =
                      pendingPrompts.find((candidate) => candidate.userMessageId === info.id) ??
                      pendingPrompts.find((candidate) => candidate.userMessageId === undefined);
                    const promptIndex = pendingPrompt ? pendingPrompts.indexOf(pendingPrompt) : -1;
                    if (promptIndex >= 0) pendingPrompts.splice(promptIndex, 1);
                    const promptChatId = pendingPrompt?.chatId;
                    if (pendingPrompt) pendingPrompt.active = false;
                    if (promptChatId) registerPromptDestination(promptChatId, info.id);
                  }
                  if (processUserMessageState(info.id, text, info.system, parentMessageId)) {
                    rescheduleCompletedChatIdle();
                    userMessageMetadata.delete(info.id);
                    partsByMessage.delete(info.id);
                  }
                } else {
                  partsByMessage.delete(info.id);
                }
                if (info.role === "assistant") {
                  assistantStreamActivity = true;
                  const destinationChatId = info.parentID ? chatByMessage.get(info.parentID) : undefined;
                  if (destinationChatId) chatByMessage.set(info.id, destinationChatId);
                  if (info.finish) {
                    markAssistantSeen(info.id);
                  sessionBusy = false;
                    hasCompletedAssistantTurn = true;
                    const recoveredText = info.error ? "" : await recoverMessageText(info.id);
                    const reply = info.error
                      ? `Agent error: ${errorMessage(info.error)}`
                      : recoveredText || text;
                    if (isActive()) {
                      if (reply) {
                        if (destinationChatId) onMessage(info.id, reply, destinationChatId);
                        else onMessage(info.id, reply);
                      }
                    }
                    scheduleIdleSettle();
                  }
                }
                break;
              }
              case "session.idle":
              case "session.status": {
                if (typedEvent.properties.sessionID !== sessionId) break;
                clearIdleCandidate();
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
          if (relevant) {
            resetQuietTimer();
            resetCeilingTimer();
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          error("watchSession stream error", err instanceof Error ? err.message : String(err));
          settle("SSE stream error");
        }
      }

    }
    const reconnectDelay = (): number | undefined => {
      if (!hasTrackedWork()) return undefined;
      return idleCandidateTimer !== undefined ? 0 : 1_000;
    };
    const subscription = this.events.subscribe(sessionId, reconnectDelay);
    unsubscribeRef.current = subscription.unsubscribe;
    void consume(subscription.stream);
    try {
      await subscription.connected;
    } catch (err) {
      settle(err instanceof Error && err.message === "SSE connection timed out" ? "SSE connection setup timed out" : "SSE subscription setup failed");
      throw err;
    }
    const acquirePrompt = (chatId: string): ((cancel?: boolean, userMessageId?: string) => void) | undefined => {
      if (controller.signal.aborted) return undefined;
      promptLeaseAcquired = true;
      const pendingPrompt: { chatId: string; active: boolean; userMessageId?: string } = { chatId, active: true };
      const lifecycle = getChatLifecycle(chatId);
      assistantStreamActivity = false;
      lifecycle.activePrompts += 1;
      clearTimeout(lifecycle.idleTimer);
      pendingPrompts.push(pendingPrompt);
      promptLeases += 1;
      clearIdleCandidate();
      resetQuietTimer();
      let released = false;
      return (cancel = false, userMessageId?: string) => {
        if (userMessageId) {
          pendingPrompt.userMessageId = userMessageId;
          registerPromptDestination(chatId, userMessageId);
        }
        if (released) return;
        released = true;
        if (cancel && pendingPrompt.active) {
          const index = pendingPrompts.indexOf(pendingPrompt);
          if (index >= 0) pendingPrompts.splice(index, 1);
          pendingPrompt.active = false;
        }
        promptLeases -= 1;
        lifecycle.activePrompts = Math.max(0, lifecycle.activePrompts - 1);
        scheduleChatIdle(chatId);
        if (controller.signal.aborted) return;
        scheduleIdleSettle();
        resetQuietTimer();
      };
    };
    const markPromptCompleted = (chatId?: string, mayHaveBackgroundWork = false): void => {
      if (controller.signal.aborted) return;
      promptMayStartBackgroundWork ||= mayHaveBackgroundWork || sessionBusy;
      hasCompletedAssistantTurn = true;
      sessionBusy = false;
      if (chatId) {
        const lifecycle = getChatLifecycle(chatId);
        lifecycle.completedPrompts += 1;
        scheduleChatIdle(chatId);
      }
      if (!promptMayStartBackgroundWork) scheduleIdleSettle();
      resetQuietTimer();
    };

    return {
      get isLive(): boolean {
        return live;
      },
      awaitIdle: () => idlePromise,
      awaitChatIdle,
      awaitTurn,
      acquirePrompt,
      markPromptCompleted,
      stop: () => {
        settle("");
      },
    };
  }
}
