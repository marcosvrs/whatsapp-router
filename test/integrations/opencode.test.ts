import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreate = vi.fn();
const sessionPrompt = vi.fn();
const eventSubscribe = vi.fn();
const createOpencodeClient = vi.fn(() => ({
  session: { create: sessionCreate, prompt: sessionPrompt },
  event: { subscribe: eventSubscribe },
}));

vi.mock("@opencode-ai/sdk", () => ({ createOpencodeClient }));

const { OpencodeClient } = await import("../../src/integrations/opencode.js");

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
  return { type: "session.status", properties: { sessionID: sessionId, status: {} } };
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function client() {
    return new OpencodeClient({ baseUrl: "http://oc.test", authHeader: "Basic abc", modelProvider: "", modelId: "" });
  }

  it("delivers each completed assistant turn as it streams in, using the latest text per part", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });
    const onMessage = vi.fn();

    const { awaitIdle, stop } = client().watchSession("ses_1", onMessage);

    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", ""));
    source.push(textPartUpdated("msg_1", "prt_1", "ses_1", "hello world"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(textPartUpdated("msg_2", "prt_2", "ses_1", "second turn"));
    source.push(assistantFinished("msg_2", "ses_1", "tool-calls"));
    source.end();

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(2);
    });
    expect(onMessage).toHaveBeenNthCalledWith(1, "msg_1", "hello world");
    expect(onMessage).toHaveBeenNthCalledWith(2, "msg_2", "second turn");

    await awaitIdle();
    stop();
  });

  it("ignores events for a different session id", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });
    const onMessage = vi.fn();

    const { stop } = client().watchSession("ses_1", onMessage);
    source.push(textPartUpdated("msg_1", "prt_1", "ses_other", "not for us"));
    source.push(assistantFinished("msg_1", "ses_other"));
    source.end();

    await vi.waitFor(() => {
      expect(eventSubscribe).toHaveBeenCalled();
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it("does not deliver a turn with no accumulated text", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });
    const onMessage = vi.fn();

    const { stop } = client().watchSession("ses_1", onMessage);
    source.push(assistantFinished("msg_1", "ses_1"));
    source.end();

    await vi.waitFor(() => {
      expect(eventSubscribe).toHaveBeenCalled();
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it("resolves awaitIdle once the stream ends on its own with no idle event", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    source.end();

    await awaitIdle();
    stop();
  });

  it("waits out the idle-grace window before resolving after session.idle", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });

    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(resolved).toBe(true);
    stop();
  });

  it("resets the idle-grace timer when more activity arrives before it elapses", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });

    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    source.push(sessionStatus("ses_1")); // any relevant event resets the quiet timer, not just idle
    await vi.advanceTimersByTimeAsync(90_000); // past the original deadline, but the reset pushed it out
    expect(resolved).toBe(false);

    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
    expect(resolved).toBe(true);
    stop();
  });

  it("hits the hard ceiling even with continuous activity that keeps resetting the quiet timer", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });

    // Reset the quiet timer every 3 minutes (under the 4-minute grace window)
    // so it never naturally elapses — proves the ceiling is an independent
    // backstop, not just a longer version of the quiet timeout.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      source.push(sessionStatus("ses_1"));
    }
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(3 * 60_000); // total 15 min — ceiling fires regardless
    expect(resolved).toBe(true);
    stop();
  });

  it("does not settle from a single idle-timing gap alone if it's under the grace window, even with zero events after", async () => {
    // Guards the real regression this design fixes: a session can go fully
    // quiet (no session.idle, no anything) once truly done, with no further
    // events at all — awaitIdle must still resolve via the quiet timer
    // itself, not depend on any particular event ever arriving.
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 59_000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(resolved).toBe(true);
    stop();
  });

  it("stop() resolves awaitIdle immediately without waiting for the grace window", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    stop();
    await awaitIdle();
  });

  it("logs and settles cleanly when the stream itself errors", async () => {
    eventSubscribe.mockRejectedValue(new Error("connection reset"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { awaitIdle, stop } = client().watchSession("ses_1", vi.fn());
    await awaitIdle();
    stop();

    expect(logSpy.mock.calls.some((call) => call[1] === "watchSession stream error")).toBe(true);
  });

  it("ignores an event type it doesn't otherwise handle (e.g. a server heartbeat)", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockResolvedValue({ stream: source.stream });
    const onMessage = vi.fn();

    const { stop } = client().watchSession("ses_1", onMessage);
    source.push({ type: "server.heartbeat", properties: {} });
    source.end();

    await vi.waitFor(() => {
      expect(eventSubscribe).toHaveBeenCalled();
    });
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });
});
