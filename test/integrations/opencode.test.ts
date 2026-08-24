import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreate = vi.fn();
const sessionPrompt = vi.fn();
const eventSubscribe = vi.fn();
const createOpencodeClient = vi.fn(() => ({
  session: { create: sessionCreate, prompt: sessionPrompt },
  event: { subscribe: eventSubscribe },
}));

vi.mock("@opencode-ai/sdk", () => ({ createOpencodeClient }));

const { OpencodeClient, IDLE_GRACE_MS, MAX_WAIT_MS, SSE_CONNECT_TIMEOUT_MS } = await import(
  "../../src/integrations/opencode.js",
);

function ok<T>(data: T, status = 200): { data: T; error: undefined; response: { status: number } } {
  return { data, error: undefined, response: { status } };
}

function fail(
  error: unknown,
  status: number,
): { data: undefined; error: unknown; response: { status: number } } {
  return { data: undefined, error, response: { status } };
}

beforeEach(() => {
  sessionCreate.mockReset();
  sessionPrompt.mockReset();
  eventSubscribe.mockReset();
  createOpencodeClient.mockClear();
});

// A controllable async-iterable event source: push() queues an event for the
// next `for await` iteration, end() completes the stream. Lets tests
// interleave pushed events with vi.advanceTimersByTimeAsync() calls, matching
// how watchSession actually consumes client.event.subscribe()'s stream.
function fakeEventSource() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  function signal(): void {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  }
  async function* generator() {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    push(event: unknown): void {
      queue.push(event);
      signal();
    },
    end(): void {
      ended = true;
      signal();
    },
    stream: generator(),
  };
}

function textPartUpdated(messageId: string, partId: string, sessionId: string, text: string) {
  return {
    type: "message.part.updated",
    properties: { part: { id: partId, messageID: messageId, sessionID: sessionId, type: "text", text } },
  };
}
function partDelta(messageId: string, partId: string, sessionId: string, delta: string) {
  return {
    type: "message.part.delta",
    properties: { messageID: messageId, partID: partId, sessionID: sessionId, field: "text", delta },
  };
}


function assistantFinished(messageId: string, sessionId: string, finish = "stop") {
  return {
    type: "message.updated",
    properties: { info: { id: messageId, sessionID: sessionId, role: "assistant", finish } },
  };
}

function sessionIdle(sessionId: string) {
  return { type: "session.idle", properties: { sessionID: sessionId } };
}

function sessionStatus(sessionId: string) {
  return { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } };
}

describe("OpencodeClient construction", () => {
  it("creates the SDK client with the base URL and Authorization header", () => {
    new OpencodeClient({
      baseUrl: "http://oc.test",
      authHeader: "Basic abc",
      modelProvider: "",
      modelId: "",
    });

    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://oc.test",
      headers: { Authorization: "Basic abc" },
    });
  });

  it("omits the Authorization header when there's no auth header", () => {
    new OpencodeClient({ baseUrl: "http://oc.test", authHeader: "", modelProvider: "", modelId: "" });

    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://oc.test",
      headers: undefined,
    });
  });
});

describe("OpencodeClient.isConfigured", () => {
  it("is false without an auth header", () => {
    expect(
      new OpencodeClient({ baseUrl: "http://oc.test", authHeader: "", modelProvider: "", modelId: "" }).isConfigured(),
    ).toBe(false);
  });

  it("is true with an auth header", () => {
    expect(
      new OpencodeClient({
        baseUrl: "http://oc.test",
        authHeader: "Basic abc",
        modelProvider: "",
        modelId: "",
      }).isConfigured(),
    ).toBe(true);
  });
});

describe("OpencodeClient.createSession", () => {
  it("returns the new session id", async () => {
    sessionCreate.mockResolvedValue(ok({ id: "ses_1" }));
    const client = new OpencodeClient({
      baseUrl: "http://oc.test",
      authHeader: "Basic abc",
      modelProvider: "",
      modelId: "",
    });

    await expect(client.createSession()).resolves.toBe("ses_1");
    expect(sessionCreate).toHaveBeenCalledWith({});
  });

  it("throws with the response status when session creation fails", async () => {
    sessionCreate.mockResolvedValue(fail({ name: "UnknownError", data: { message: "boom" } }, 500));
    const client = new OpencodeClient({
      baseUrl: "http://oc.test",
      authHeader: "Basic abc",
      modelProvider: "",
      modelId: "",
    });

    await expect(client.createSession()).rejects.toThrow("session create failed: 500");
  });
});

describe("OpencodeClient.send", () => {
  function client(modelProvider = "", modelId = ""): InstanceType<typeof OpencodeClient> {
    return new OpencodeClient({ baseUrl: "http://oc.test", authHeader: "Basic abc", modelProvider, modelId });
  }

  it("sends the message via session.prompt with the exact path and text part", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "hi");

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "hi" }] },
    });
  });

  it("attaches a file part alongside the text part when media is provided", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "check this out", {
      media: [{ mimetype: "image/jpeg", dataBase64: "Zm9v", filename: "photo.jpg" }],
    });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [
          { type: "text", text: "check this out" },
          { type: "file", mime: "image/jpeg", filename: "photo.jpg", url: "data:image/jpeg;base64,Zm9v" },
        ],
      },
    });
  });

  it("sends only the file part when there is media but no caption text", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "", {
      media: [{ mimetype: "application/pdf", dataBase64: "YmFy" }],
    });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [{ type: "file", mime: "application/pdf", filename: undefined, url: "data:application/pdf;base64,YmFy" }],
      },
    });
  });

  it("attaches a file part per item when multiple media are provided", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "context from earlier", {
      media: [
        { mimetype: "image/jpeg", dataBase64: "aaa", filename: "one.jpg" },
        { mimetype: "application/pdf", dataBase64: "bbb", filename: "two.pdf" },
      ],
    });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [
          { type: "text", text: "context from earlier" },
          { type: "file", mime: "image/jpeg", filename: "one.jpg", url: "data:image/jpeg;base64,aaa" },
          { type: "file", mime: "application/pdf", filename: "two.pdf", url: "data:application/pdf;base64,bbb" },
        ],
      },
    });
  });

  it("sends no file part when media is an empty array", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "hi", { media: [] });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "hi" }] },
    });
  });

  it("includes the system field when provided", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "hi", { system: "You are Jarvis, reached via WhatsApp." });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [{ type: "text", text: "hi" }],
        system: "You are Jarvis, reached via WhatsApp.",
      },
    });
  });

  it("omits the system field when not provided", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "hi");

    const call = sessionPrompt.mock.calls[0] as [{ body: { system?: unknown } }];
    expect(call[0].body.system).toBeUndefined();
  });

  it("includes both media and system together", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client().send("ses_1", "check this out", {
      media: [{ mimetype: "image/jpeg", dataBase64: "Zm9v" }],
      system: "You are Jarvis.",
    });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [
          { type: "text", text: "check this out" },
          { type: "file", mime: "image/jpeg", filename: undefined, url: "data:image/jpeg;base64,Zm9v" },
        ],
        system: "You are Jarvis.",
      },
    });
  });

  it("returns the concatenated text parts of a successful reply", async () => {
    sessionPrompt.mockResolvedValue(
      ok({
        info: {},
        parts: [
          { type: "text", text: "hello" },
          { type: "step-finish" },
          { type: "text", text: "world" },
        ],
      }),
    );
    const result = await client().send("ses_1", "hi");
    expect(result).toEqual({ sessionId: "ses_1", reply: "hello\nworld" });
  });

  it("returns a placeholder when there are no text parts", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("(no output)");
  });

  it("formats an agent error from the response", async () => {
    sessionPrompt.mockResolvedValue(
      ok({ info: { error: { data: { message: "Insufficient balance." } } }, parts: [] }),
    );
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("Agent error: Insufficient balance.");
  });

  it("falls back to the error name when there's no data.message", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: { error: { name: "APIError" } }, parts: [] }));
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("Agent error: APIError");
  });

  it("falls back to the error name when data is an untyped bag without a message (e.g. MessageOutputLengthError)", async () => {
    sessionPrompt.mockResolvedValue(
      ok({ info: { error: { name: "MessageOutputLengthError", data: {} } }, parts: [] }),
    );
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("Agent error: MessageOutputLengthError");
  });

  it("logs the exact error message it formats", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    sessionPrompt.mockResolvedValue(ok({ info: { error: { name: "APIError" } }, parts: [] }));
    await client().send("ses_1", "hi");

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["opencode agent error", "APIError"]);
    logSpy.mockRestore();
  });

  it("ignores text parts with an empty/undefined text field", async () => {
    sessionPrompt.mockResolvedValue(
      ok({ info: {}, parts: [{ type: "text" }, { type: "text", text: "real" }] }),
    );
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("real");
  });

  it("creates a fresh session and retries once on a 404 (stale session)", async () => {
    sessionPrompt
      .mockResolvedValueOnce(fail({ name: "NotFoundError", data: { message: "not found" } }, 404))
      .mockResolvedValueOnce(ok({ info: {}, parts: [{ type: "text", text: "ok" }] }));
    sessionCreate.mockResolvedValue(ok({ id: "ses_new" }));

    const result = await client().send("ses_stale", "hi");

    expect(result).toEqual({ sessionId: "ses_new", reply: "ok" });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(sessionPrompt).toHaveBeenCalledTimes(2);
    expect(sessionPrompt).toHaveBeenNthCalledWith(2, {
      path: { id: "ses_new" },
      body: { parts: [{ type: "text", text: "hi" }] },
    });
  });

  it("includes a model override when provider and id are both set", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client("openai", "gpt-5.6-luna").send("ses_1", "hi");

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [{ type: "text", text: "hi" }],
        model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      },
    });
  });

  it("omits the model override when only the provider is set", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client("openai", "").send("ses_1", "hi");

    const call = sessionPrompt.mock.calls[0] as [{ body: { model?: unknown } }];
    expect(call[0].body.model).toBeUndefined();
  });

  it("omits the model override when only the model id is set", async () => {
    sessionPrompt.mockResolvedValue(ok({ info: {}, parts: [] }));
    await client("", "gpt-5.6-luna").send("ses_1", "hi");

    const call = sessionPrompt.mock.calls[0] as [{ body: { model?: unknown } }];
    expect(call[0].body.model).toBeUndefined();
  });

  it("throws with the response status when the retried prompt also fails without a 404", async () => {
    sessionPrompt.mockResolvedValue(fail({ name: "UnknownError", data: { message: "boom" } }, 500));
    await expect(client().send("ses_1", "hi")).rejects.toThrow("opencode message send failed: 500");
  });
});

describe("OpencodeClient.watchSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(":\n\n", { status: 200 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function client() {
    return new OpencodeClient({ baseUrl: "http://oc.test", authHeader: "Basic abc", modelProvider: "", modelId: "" });
  }

  function connectSource(
    source: { stream: AsyncIterable<unknown>; push: (event: unknown) => void },
    emitConnected = true,
  ): void {
    eventSubscribe.mockImplementation(() => {
      if (emitConnected) source.push({ type: "server.connected", properties: {} });
      return { stream: source.stream };
    });
  }

  it("delivers each completed assistant turn as it streams in, using the latest text per part", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { awaitIdle, stop } = await client().watchSession("ses_1", onMessage);

    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", ""));
    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", "hello world"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(textPartUpdated("msg_2", "prt_2", "ses_1", "second turn"));
    source.push(assistantFinished("msg_2", "ses_1", "tool-calls"));

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(2);
    });
    expect(onMessage).toHaveBeenNthCalledWith(1, "msg_1", "hello world");
    expect(onMessage).toHaveBeenNthCalledWith(2, "msg_2", "second turn");
    stop();
    await awaitIdle();
  });
  it("accumulates text from message.part.delta events", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);

    source.push(partDelta("msg_1", "prt_1", "ses_1", "hello "));
    source.push(partDelta("msg_1", "prt_1", "ses_1", "world"));
    source.push(assistantFinished("msg_1", "ses_1"));

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("msg_1", "hello world");
    });
    stop();
  });

  it("waits for the actual SSE stream before returning", async () => {
    const source = fakeEventSource();
    connectSource(source, false);
    let resolved = false;
    const watchPromise = client()
      .watchSession("ses_1", vi.fn())
      .then((watch) => {
        resolved = true;
        return watch;
      });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    source.push({ type: "server.connected", properties: {} });
    const watch = await watchPromise;
    expect(resolved).toBe(true);
    watch.stop();
  });


  it("ignores events for a different session id", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(textPartUpdated("msg_1", "prt_1", "ses_other", "not for us"));
    source.push(assistantFinished("msg_1", "ses_other"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it("does not deliver a turn with no accumulated text", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(assistantFinished("msg_1", "ses_1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it("resolves awaitIdle when the stream ends on its own", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle } = await client().watchSession("ses_1", vi.fn());
    source.end();
    await awaitIdle();
  });

  it("settles promptly when an assistant turn is followed by an idle status", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", "done"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(sessionStatus("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });

  it("does not settle while the session remains busy during a silent tool call", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", "working"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + 1);
    expect(resolved).toBe(false);
    stop();
  });

  it("keeps watching across background-task idle gaps until completion marker", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(textPartUpdated("user_1", "part_1", "ses_1", "[BACKGROUND TASK RESULT READY] still in progress"));
    source.push({ type: "message.updated", properties: { info: { id: "user_1", sessionID: "ses_1", role: "user" } } });
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(false);
    source.push(textPartUpdated("user_2", "part_2", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    source.push({ type: "message.updated", properties: { info: { id: "user_2", sessionID: "ses_1", role: "user" } } });
    source.push(textPartUpdated("msg_2", "part_3", "ses_1", "final"));
    source.push(assistantFinished("msg_2", "ses_1"));
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });
  it("does not pin the watcher for ordinary user text mentioning background tasks", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(textPartUpdated("user_1", "part_1", "ses_1", "What is a BACKGROUND TASK?"));
    source.push({ type: "message.updated", properties: { info: { id: "user_1", sessionID: "ses_1", role: "user" } } });
    source.push(textPartUpdated("msg_1", "part_2", "ses_1", "It is work that runs later."));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });

  it("keeps a watcher alive while a prompt lease is active", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, acquirePrompt, stop } = await client().watchSession("ses_1", vi.fn());
    source.push(textPartUpdated("msg_1", "part_1", "ses_1", "first"));
    source.push(assistantFinished("msg_1", "ses_1"));
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    const release = acquirePrompt();
    expect(release).toBeTypeOf("function");
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(false);
    release?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });


  it("hits the hard ceiling even with continuous activity", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    const resetInterval = IDLE_GRACE_MS - 1_000;
    let elapsed = 0;
    while (elapsed + resetInterval < MAX_WAIT_MS) {
      await vi.advanceTimersByTimeAsync(resetInterval);
      elapsed += resetInterval;
      source.push({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    }
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - elapsed + 1);
    expect(resolved).toBe(true);
    stop();
  });

  it("delivers the authoritative agent error instead of partial text", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", "partial"));
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          finish: "stop",
          error: { name: "APIError", data: { message: "failed" } },
        },
      },
    });
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("msg_1", "Agent error: failed");
    });
    stop();
  });
  it("rejects when the initial SSE connection fails and cleans up timers", async () => {
    eventSubscribe.mockRejectedValue(new Error("connection reset"));
    await expect(client().watchSession("ses_1", vi.fn())).rejects.toThrow("connection reset");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out when the actual SSE stream never connects", async () => {
    const source = fakeEventSource();
    connectSource(source, false);
    const watchPromise = client().watchSession("ses_1", vi.fn());
    const rejection = expect(watchPromise).rejects.toThrow("SSE connection timed out");
    await vi.advanceTimersByTimeAsync(SSE_CONNECT_TIMEOUT_MS);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });


  it("logs and settles cleanly when the stream errors after connecting", async () => {
    const throwingStream = {
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (first) {
              first = false;
              return Promise.resolve({
                done: false,
                value: { type: "server.connected", properties: {} },
              });
            }
            return Promise.reject(new Error("dropped mid-stream"));
          },
        };
      },
    };
    eventSubscribe.mockResolvedValue({ stream: throwingStream });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { awaitIdle } = await client().watchSession("ses_1", vi.fn());
    await awaitIdle();
    expect(logSpy.mock.calls.some((call) => call[1] === "watchSession stream error")).toBe(true);
    logSpy.mockRestore();
  });

  it("ignores an unhandled event type", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push({ type: "server.heartbeat", properties: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });
});
