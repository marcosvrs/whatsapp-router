import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreate = vi.fn();
const sessionPrompt = vi.fn();
const sessionMessage = vi.fn();
const eventSubscribe = vi.fn();
const createOpencodeClient = vi.fn(() => ({
  session: { create: sessionCreate, prompt: sessionPrompt, message: sessionMessage },
  event: { subscribe: eventSubscribe },
}));

vi.mock("@opencode-ai/sdk", () => ({ createOpencodeClient }));

const {
  OpencodeClient,
  OpencodeSendError,
  IDLE_GRACE_MS,
  MAX_WAIT_MS,
  TURN_RECONCILE_MS,
  SSE_CONNECT_TIMEOUT_MS,
  backgroundWorkState,
  errorMessage,
  isMessagePartDeltaEvent,
  mayBeBackgroundMarkerPrefix,
} = await import("../../src/integrations/opencode.js");

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
  sessionMessage.mockReset();
  sessionMessage.mockResolvedValue(ok({ info: {}, parts: [] }));
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

function assistantFinished(messageId: string, sessionId: string, finish = "stop", parentId?: string) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
        finish,
        ...(parentId ? { parentID: parentId } : {}),
      },
    },
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
  it("trims and filters successful text parts", async () => {
    sessionPrompt.mockResolvedValue(
      ok({
        info: {},
        parts: [
          { type: "text", text: "  hello  " },
          { type: "text", text: "" },
          { type: "step-finish", text: "must be ignored" },
          { type: "text", text: "world" },
        ],
      }),
    );
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("hello  \nworld");
  });

  it("falls back to the error name for malformed error data", async () => {
    sessionPrompt.mockResolvedValue(
      ok({ info: { name: "APIError", error: { name: "APIError", data: { message: 42 } } }, parts: [] }),
    );
    const result = await client().send("ses_1", "hi");
    expect(result.reply).toBe("Agent error: APIError");
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
  it("starts the replacement hook before retrying a stale session prompt", async () => {
    const order: string[] = [];
    sessionPrompt
      .mockImplementationOnce(() => {
        order.push("old prompt");
        return Promise.resolve(fail({ name: "NotFoundError" }, 404));
      })
      .mockImplementationOnce(() => {
        order.push("retry prompt");
        return Promise.resolve(ok({ info: {}, parts: [] }));
      });
    sessionCreate.mockImplementation(() => {
      order.push("create session");
      return Promise.resolve(ok({ id: "ses_new" }));
    });
    const onSessionReplaced = vi.fn((sessionId: string) => {
      order.push(`watch ${sessionId}`);
      return Promise.resolve();
    });

    await client().send("ses_stale", "hi", { onSessionReplaced });

    expect(order).toEqual(["old prompt", "create session", "watch ses_new", "retry prompt"]);
    expect(onSessionReplaced).toHaveBeenCalledWith("ses_new");
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

describe("background task classifiers", () => {
  it("distinguish progress, completion, ordinary text, and marker prefixes", () => {
    expect(backgroundWorkState("  [BACKGROUND TASK RESULT READY] work")).toBe(true);
    expect(backgroundWorkState("  [ALL BACKGROUND TASKS COMPLETE] done")).toBe(false);
    expect(backgroundWorkState("ordinary message")).toBeUndefined();
    expect(mayBeBackgroundMarkerPrefix("  [BACKGROUND TASK RESULT READY]")).toBe(true);
    expect(mayBeBackgroundMarkerPrefix("  [BACKGROUND TASK RETRYING]")).toBe(true);
    expect(mayBeBackgroundMarkerPrefix("  [ALL BACKGROUND TASKS COMPLETE]")).toBe(true);
    expect(mayBeBackgroundMarkerPrefix("ordinary message")).toBe(false);
    expect(mayBeBackgroundMarkerPrefix("[BACKGROUND TASK RES")).toBe(true);
    expect(mayBeBackgroundMarkerPrefix("[BACKGROUND TASK RESULT READY] details")).toBe(true);
    expect(mayBeBackgroundMarkerPrefix("TASKS COMPLETE]")).toBe(false);
    expect(mayBeBackgroundMarkerPrefix("prefix [ALL BACKGROUND TASKS COMPLETE]")).toBe(false);
  });

  it("uses an error detail only when it is a string message", () => {
    expect(errorMessage({ name: "E", data: { message: "detail" } } as never)).toBe("detail");
    for (const data of [undefined, null, false, 0, "detail", { message: 42 }, { other: "detail" }]) {
      expect(errorMessage({ name: "E", data } as never)).toBe("E");
    }
  });
  it("names send errors with their integration class", () => {
    const error = new OpencodeSendError(502);
    expect(error.name).toBe("OpencodeSendError");
    expect(error.status).toBe(502);
    expect(error.message).toBe("opencode message send failed: 502");
  });

});
describe("isMessagePartDeltaEvent", () => {
  it("accepts a complete delta payload and rejects malformed shapes", () => {
    const valid = {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "hello",
      },
    };
    expect(isMessagePartDeltaEvent(valid)).toBe(true);
    expect(isMessagePartDeltaEvent(null)).toBe(false);
    expect(isMessagePartDeltaEvent("message.part.delta")).toBe(false);
    expect(isMessagePartDeltaEvent({ type: "other", properties: valid.properties })).toBe(false);
    expect(isMessagePartDeltaEvent({ type: valid.type })).toBe(false);
    expect(isMessagePartDeltaEvent({ type: valid.type, properties: null })).toBe(false);
    expect(isMessagePartDeltaEvent({ type: valid.type, properties: "bad" })).toBe(false);
    for (const field of ["sessionID", "messageID", "partID", "field", "delta"]) {
      expect(
        isMessagePartDeltaEvent({
          type: valid.type,
          properties: { ...valid.properties, [field]: 42 },
        }),
      ).toBe(false);
    }
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const onMessage = vi.fn();
    const watch = await client().watchSession("ses_1", onMessage);
    const { awaitIdle, stop } = watch;
    expect(watch.isLive).toBe(true);

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
    expect(logSpy).not.toHaveBeenCalled();
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

  it("accepts the SDK connection callback before the stream yields", async () => {
    const source = fakeEventSource();
    eventSubscribe.mockImplementation((options: { onSseEvent?: () => void }) => {
      options.onSseEvent?.();
      return { stream: source.stream };
    });
    const watch = await client().watchSession("ses_1", vi.fn());
    watch.stop();
  });

  it("reports a pre-prompt watcher as non-live when its stream closes", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    source.end();
    await vi.advanceTimersByTimeAsync(0);

    expect(watch.isLive).toBe(false);
    expect(watch.acquirePrompt("chat1")).toBeUndefined();
  });

  it("keeps a leased watcher live when it settles", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");

    expect(watch.isLive).toBe(true);
    release?.();
    watch.stop();
    expect(watch.isLive).toBe(true);
  });


  it("routes completed turns to the prompt's originating chat", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const watch = await client().watchSession("ses_1", onMessage);

    const releaseDirect = watch.acquirePrompt("direct");
    source.push(textPartUpdated("user_direct", "part_1", "ses_1", "private"));
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_direct",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("assistant_direct", "part_2", "ses_1", "private reply"));
    source.push(assistantFinished("assistant_direct", "ses_1", "stop", "user_direct"));
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("assistant_direct", "private reply", "direct");
    });
    releaseDirect?.();

    const releaseGroup = watch.acquirePrompt("group");
    source.push(textPartUpdated("user_group", "part_3", "ses_1", "group"));
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_group",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("assistant_group", "part_4", "ses_1", "group reply"));
    source.push(assistantFinished("assistant_group", "ses_1", "stop", "user_group"));
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("assistant_group", "group reply", "group");
    });
    releaseGroup?.();
    watch.stop();
  });
  it("removes a canceled prompt destination before the next prompt", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const watch = await client().watchSession("ses_1", onMessage);
    const canceled = watch.acquirePrompt("direct");
    canceled?.(true);
    const release = watch.acquirePrompt("group");

    source.push(textPartUpdated("user_group", "part_1", "ses_1", "group"));
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_group",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("assistant_group", "part_2", "ses_1", "group reply"));
    source.push(assistantFinished("assistant_group", "ses_1", "stop", "user_group"));

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("assistant_group", "group reply", "group");
    });
    release?.();
    watch.stop();
  });

  it("keeps overlapping background destinations separate", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const watch = await client().watchSession("ses_1", onMessage);

    const releaseDirect = watch.acquirePrompt("direct");
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_direct",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_direct", sessionID: "ses_1", role: "user" } },
    });
    source.push(
      textPartUpdated("marker_direct", "part_1", "ses_1", "[BACKGROUND TASK RESULT READY] still in progress"),
    );
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_direct_retry", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("marker_direct_retry", "part_retry", "ses_1", "[BACKGROUND TASK RETRYING] still in progress"));
    releaseDirect?.();

    const releaseGroup = watch.acquirePrompt("group");
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_group",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_group", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("marker_group", "part_2", "ses_1", "[BACKGROUND TASK RESULT READY] still in progress"));
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_group_round", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("marker_group_round", "part_round", "ses_1", "[BACKGROUND TASK RESULT READY] still in progress"));
    source.push({
      type: "message.updated",
      properties: { info: { id: "complete_direct", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("complete_direct", "part_complete", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    source.push({
      type: "message.updated",
      properties: { info: { id: "complete_group", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("complete_group", "part_complete", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    source.push(textPartUpdated("assistant_direct", "part_3", "ses_1", "direct background"));
    source.push(assistantFinished("assistant_direct", "ses_1", "stop", "marker_direct"));
    source.push(textPartUpdated("assistant_group", "part_4", "ses_1", "group background"));
    source.push(assistantFinished("assistant_group", "ses_1", "stop", "marker_group"));

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("assistant_direct", "direct background", "direct");
      expect(onMessage).toHaveBeenCalledWith("assistant_group", "group background", "group");
    });
    releaseGroup?.();
    watch.stop();
  });


  it("settles after a malformed SSE event", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle } = await client().watchSession("ses_1", vi.fn());
    source.push(null);
    await awaitIdle();
  });

  it("logs SSE retry errors before the stream ends", async () => {
    const source = fakeEventSource();

    eventSubscribe.mockImplementation((options: { onSseError?: (error: unknown) => void }) => {
      options.onSseError?.(new Error("retry"));
      source.push({ type: "server.connected", properties: {} });
      source.end();
      return { stream: source.stream };
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { awaitIdle } = await client().watchSession("ses_1", vi.fn());
    await awaitIdle();
    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["watchSession SSE connect attempt failed, retrying", "retry"]);
    expect(logged).toContainEqual([
      "watchSession stream ended after connection retries were exhausted — may not reflect the session actually being done",
    ]);
    logSpy.mockRestore();
  });

  it("reconnects after exhausted SSE retries while a prompt lease is active", async () => {
    const first = fakeEventSource();
    const second = fakeEventSource();
    eventSubscribe
      .mockImplementationOnce(() => {
        first.push({ type: "server.connected", properties: {} });
        return { stream: first.stream };
      })
      .mockImplementationOnce(() => {
        second.push({ type: "server.connected", properties: {} });
        return { stream: second.stream };
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const onMessage = vi.fn();
    const watch = await client().watchSession("ses_1", onMessage);
    const release = watch.acquirePrompt("chat1");

    first.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventSubscribe).toHaveBeenCalledTimes(2);

    second.push(textPartUpdated("msg_1", "part_1", "ses_1", "after reconnect"));
    second.push(assistantFinished("msg_1", "ses_1"));
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("msg_1", "after reconnect");
    });

    release?.();
    second.end();
    await vi.advanceTimersByTimeAsync(1_001);
    await watch.awaitIdle();
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).not.toContainEqual([
      "watchSession stream ended after connection retries were exhausted — may not reflect the session actually being done",
    ]);
  });

  it("reconnects during post-prompt grace before a detached-work marker", async () => {
    const first = fakeEventSource();
    const second = fakeEventSource();
    eventSubscribe
      .mockImplementationOnce(() => {
        first.push({ type: "server.connected", properties: {} });
        return { stream: first.stream };
      })
      .mockImplementationOnce(() => {
        second.push({ type: "server.connected", properties: {} });
        return { stream: second.stream };
      });
    const onMessage = vi.fn();
    const watch = await client().watchSession("ses_1", onMessage);
    const release = watch.acquirePrompt("chat1");
    first.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_chat1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    first.push(textPartUpdated("user_chat1", "part_user", "ses_1", "start background"));
    await vi.advanceTimersByTimeAsync(0);
    watch.markPromptCompleted("chat1");
    release?.();

    first.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventSubscribe).toHaveBeenCalledTimes(2);

    second.push({
      type: "message.updated",
      properties: { info: { id: "marker_chat1", sessionID: "ses_1", role: "user" } },
    });
    second.push(
      textPartUpdated("marker_chat1", "part_marker", "ses_1", "[BACKGROUND TASK RESULT READY] still working"),
    );
    second.push(textPartUpdated("assistant_chat1", "part_assistant", "ses_1", "detached result"));
    second.push(assistantFinished("assistant_chat1", "ses_1", "stop", "marker_chat1"));
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("assistant_chat1", "detached result", "chat1");
    });
    watch.stop();
  });

  it("retries a reconnect failure while tracked work remains", async () => {
    const first = fakeEventSource();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    eventSubscribe
      .mockImplementationOnce(() => {
        first.push({ type: "server.connected", properties: {} });
        return { stream: first.stream };
      })
      .mockRejectedValueOnce(new Error("reconnect down"));
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");

    first.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "watchSession reconnect failed, retrying",
      "reconnect down",
    ]);

    release?.();
    watch.stop();
  });

  it("does not reconnect after tracked work is released before retry", async () => {
    const first = fakeEventSource();
    eventSubscribe.mockImplementationOnce(() => {
      first.push({ type: "server.connected", properties: {} });
      return { stream: first.stream };
    });
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");

    first.end();
    await vi.advanceTimersByTimeAsync(0);
    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventSubscribe).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("reconnects when a silent tool keeps the session busy", async () => {
    const first = fakeEventSource();
    const second = fakeEventSource();
    eventSubscribe
      .mockImplementationOnce(() => {
        first.push({ type: "server.connected", properties: {} });
        return { stream: first.stream };
      })
      .mockImplementationOnce(() => {
        second.push({ type: "server.connected", properties: {} });
        return { stream: second.stream };
      });
    const watch = await client().watchSession("ses_1", vi.fn());
    first.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "tool_1",
        partID: "tool_part",
        field: "tool-input",
        delta: "{}",
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    first.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventSubscribe).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("rejects malformed delta payloads before processing valid text", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    const invalidEvents = [
      { type: "message.part.delta", properties: null },
      { type: "message.part.delta", properties: { sessionID: "ses_1" } },
      {
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_bad", partID: "part", field: "text", delta: 42 },
      },
      {
        type: "message.part.delta",
        properties: { sessionID: 1, messageID: "msg_bad", partID: "part", field: "text", delta: "bad" },
      },
    ];
    for (const event of invalidEvents) source.push(event);
    source.push(partDelta("msg_1", "part_1", "ses_1", "good"));
    source.push(assistantFinished("msg_1", "ses_1"));
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("msg_1", "good");
    });
    stop();
  });

  it("cancels an idle candidate when a relevant event arrives", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    source.push(textPartUpdated("msg_1", "part_1", "ses_1", "done"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(500);
    source.push({ type: "message.updated", properties: { info: { id: "noise", sessionID: "ses_1", role: "assistant" } } });
    await vi.advanceTimersByTimeAsync(600);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    await awaitIdle();
  });

  it("cleans an ordinary injected message after its parts arrive", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { stop } = await client().watchSession("ses_1", vi.fn());
    source.push({ type: "message.updated", properties: { info: { id: "plugin", sessionID: "ses_1", role: "user" } } });
    source.push(textPartUpdated("plugin", "part_empty", "ses_1", ""));
    source.push(textPartUpdated("plugin", "part_1", "ses_1", "ordinary plugin note"));
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it("stops before processing events queued after abort", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");
    watch.stop();
    release?.();
    watch.markPromptCompleted();
    expect(watch.acquirePrompt("chat1")).toBeUndefined();
    source.push({ type: "server.connected", properties: {} });
    await watch.awaitIdle();
  });

  it("ignores events for a different session id", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(textPartUpdated("msg_1", "prt_1", "ses_other", "not for us"));
    source.push(assistantFinished("msg_1", "ses_other"));
    source.push(sessionStatus("ses_other"));
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

  it("clears the busy latch on a terminal assistant finish", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "tool_1",
        field: "tool_input",
        delta: "{}",
      },
    });
    source.push({
      type: "message.part.updated",
      properties: {
        part: { id: "tool_1", messageID: "msg_1", sessionID: "ses_1", type: "tool" },
      },
    });
    source.push(textPartUpdated("msg_1", "part_1", "ses_1", "done"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });
  it("settles through the quiet timer after terminal activity", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    source.push(textPartUpdated("msg_1", "part_1", "ses_1", "done"));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push({ type: "message.updated", properties: { info: { id: "noise", sessionID: "ses_1", role: "user" } } });
    await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + 1);
    await awaitIdle();
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "watchSession",
      "quiet with no activity for the grace window",
    ]);
    stop();
  });

  it("processes background markers when message.updated precedes its parts", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push({ type: "message.updated", properties: { info: { id: "user_1", sessionID: "ses_1", role: "user" } } });
    source.push(partDelta("user_1", "part_1", "ses_1", "[BACKGROUND TASK RESULT READY] still in progress"));
    source.push({ type: "message.updated", properties: { info: { id: "user_1", sessionID: "ses_1", role: "user" } } });
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(false);

    source.push({ type: "message.updated", properties: { info: { id: "user_2", sessionID: "ses_1", role: "user" } } });
    source.push(textPartUpdated("user_2", "part_2", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    source.push(textPartUpdated("msg_2", "part_3", "ses_1", "final"));
    source.push(assistantFinished("msg_2", "ses_1"));
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });

  it("processes text from message.part.delta after user metadata arrives", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push({ type: "message.updated", properties: { info: { id: "user_delta", sessionID: "ses_1", role: "user" } } });
    source.push(partDelta("user_delta", "part_delta", "ses_1", "ordinary text"));
    source.push(textPartUpdated("assistant_delta", "part_assistant", "ses_1", "reply"));
    source.push(assistantFinished("assistant_delta", "ses_1"));
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("assistant_delta", "reply");
    });
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
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("msg_1", "part_2", "ses_1", "It is work that runs later."));
    source.push(assistantFinished("msg_1", "ses_1"));
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });
  it("does not treat an exact background marker in user input as plugin state", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(textPartUpdated("user_1", "part_1", "ses_1", "[BACKGROUND TASK RESULT READY]"));
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("assistant_1", "part_2", "ses_1", "ordinary reply"));
    source.push(assistantFinished("assistant_1", "ses_1", "stop", "user_1"));
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
    const release = acquirePrompt("chat1");
    expect(release).toBeTypeOf("function");
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(false);
    release?.();
    release?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });

  it("ends typing per chat while another chat keeps background work active", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const releaseChat1 = watch.acquirePrompt("chat1");
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_chat1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("user_chat1", "part_user", "ses_1", "start background"));
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_chat1", sessionID: "ses_1", role: "user" } },
    });
    source.push(
      textPartUpdated("marker_chat1", "part_marker", "ses_1", "[BACKGROUND TASK RESULT READY] still working"),
    );
    await vi.advanceTimersByTimeAsync(0);

    const chat1Idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    let chat1Done = false;
    void chat1Idle.then(() => {
      chat1Done = true;
    });
    watch.markPromptCompleted("chat1");
    releaseChat1?.();

    const releaseChat2 = watch.acquirePrompt("chat2");
    const chat2Idle = watch.awaitChatIdle?.("chat2") ?? Promise.resolve();
    let chat2Done = false;
    void chat2Idle.then(() => {
      chat2Done = true;
    });
    watch.markPromptCompleted("chat2");
    releaseChat2?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(chat2Done).toBe(true);
    expect(chat1Done).toBe(false);

    source.push({
      type: "message.updated",
      properties: { info: { id: "complete_chat1", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("complete_chat1", "part_complete", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(chat1Done).toBe(true);
    watch.stop();
  });
  it("keeps another chat's pending marker from blocking completed chat work", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release1 = watch.acquirePrompt("chat1");
    const release2 = watch.acquirePrompt("chat2");
    for (const [chatId, userId, markerId] of [
      ["chat1", "user_chat1", "marker_chat1"],
      ["chat2", "user_chat2", "marker_chat2"],
    ] as const) {
      source.push({
        type: "message.updated",
        properties: {
          info: {
            id: userId,
            sessionID: "ses_1",
            role: "user",
            system: "You are being reached over WhatsApp.",
          },
        },
      });
      source.push(textPartUpdated(userId, `part_${chatId}`, "ses_1", `start ${chatId}`));
      source.push({
        type: "message.updated",
        properties: { info: { id: markerId, sessionID: "ses_1", role: "user" } },
      });
      source.push(
        textPartUpdated(markerId, `marker_${chatId}`, "ses_1", "[BACKGROUND TASK RESULT READY] still working"),
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    source.push({
      type: "message.updated",
      properties: { info: { id: "complete_chat1", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("complete_chat1", "part_complete", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    await vi.advanceTimersByTimeAsync(0);

    const chat1Idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    let chat1Done = false;
    void chat1Idle.then(() => {
      chat1Done = true;
    });
    watch.markPromptCompleted("chat1");
    release1?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(chat1Done).toBe(true);

    release2?.();
    watch.stop();
  });

  it("cancels a per-chat idle timer when background work starts", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");
    const idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    let done = false;
    void idle.then(() => {
      done = true;
    });
    watch.markPromptCompleted("chat1");
    release?.();
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_chat1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("user_chat1", "part_user", "ses_1", "start background"));
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_chat1", sessionID: "ses_1", role: "user" } },
    });
    source.push(
      textPartUpdated("marker_chat1", "part_marker", "ses_1", "[BACKGROUND TASK RESULT READY] still working"),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(done).toBe(false);
    watch.stop();
  });

  it("does not end per-chat typing before delayed marker parts arrive", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_chat1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("user_chat1", "part_user", "ses_1", "start background"));
    await vi.advanceTimersByTimeAsync(0);
    watch.markPromptCompleted("chat1");
    release?.();

    let done = false;
    const idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    void idle.then(() => {
      done = true;
    });
    source.push({
      type: "message.updated",
      properties: { info: { id: "marker_chat1", sessionID: "ses_1", role: "user" } },
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(done).toBe(false);

    source.push(
      textPartUpdated("marker_chat1", "part_marker", "ses_1", "[BACKGROUND TASK RESULT READY] still working"),
    );
    await vi.advanceTimersByTimeAsync(0);
    source.push({
      type: "message.updated",
      properties: { info: { id: "complete_chat1", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("complete_chat1", "part_complete", "ses_1", "[ALL BACKGROUND TASKS COMPLETE]"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(done).toBe(true);
    watch.stop();
  });

  it("rearms per-chat idle after an ordinary user message is classified", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");
    source.push({
      type: "message.updated",
      properties: {
        info: {
          id: "user_chat1",
          sessionID: "ses_1",
          role: "user",
          system: "You are being reached over WhatsApp.",
        },
      },
    });
    source.push(textPartUpdated("user_chat1", "part_user", "ses_1", "ordinary prompt"));
    await vi.advanceTimersByTimeAsync(0);
    watch.markPromptCompleted("chat1");
    release?.();

    let done = false;
    const idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    void idle.then(() => {
      done = true;
    });
    source.push({
      type: "message.updated",
      properties: { info: { id: "ordinary_chat1", sessionID: "ses_1", role: "user" } },
    });
    source.push(textPartUpdated("ordinary_chat1", "part_ordinary", "ses_1", "ordinary text"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(done).toBe(true);
    watch.stop();
  });

  it("resolves pending chat and turn waiters when the watcher stops", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const chatIdle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    source.push(assistantFinished("old_turn", "ses_1"));
    await vi.advanceTimersByTimeAsync(0);
    const turn = watch.awaitTurn?.("missing_turn") ?? Promise.resolve();

    watch.stop();
    await watch.awaitChatIdle?.("after-stop");
    await Promise.all([chatIdle, turn]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("resolves a turn waiter when its SSE completion arrives", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    source.push(assistantFinished("old_turn", "ses_1"));
    await vi.advanceTimersByTimeAsync(0);
    const turn = watch.awaitTurn?.("target_turn") ?? Promise.resolve();
    source.push(assistantFinished("target_turn", "ses_1"));
    await turn;
    let alreadySeen = false;
    void (watch.awaitTurn?.("target_turn") ?? Promise.resolve()).then(() => {
      alreadySeen = true;
    });
    await Promise.resolve();
    expect(alreadySeen).toBe(true);
    watch.stop();
    let afterStop = false;
    void (watch.awaitTurn?.("after_stop") ?? Promise.resolve()).then(() => {
      afterStop = true;
    });
    await Promise.resolve();
    expect(afterStop).toBe(true);
  });
  it("waits briefly for stream activity before releasing an authoritative turn", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    source.push({
      type: "message.updated",
      properties: { info: { id: "streaming", sessionID: "ses_1", role: "assistant" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    let resolved = false;
    const wait = watch.awaitTurn?.("missing_turn") ?? Promise.resolve();
    void wait.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(TURN_RECONCILE_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    watch.stop();
  });
  it("does not delay an authoritative turn before any SSE assistant activity", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void (watch.awaitTurn?.("before_activity") ?? Promise.resolve()).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
    watch.stop();
  });

  it("resolves a single prompt-specific idle waiter after its prompt completes", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const release = watch.acquirePrompt("chat1");
    const idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    let resolved = false;
    void idle.then(() => {
      resolved = true;
    });
    watch.markPromptCompleted("chat1");
    release?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    watch.stop();
  });

  it("keeps a chat idle wait pending while another prompt remains active", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const watch = await client().watchSession("ses_1", vi.fn());
    const firstRelease = watch.acquirePrompt("chat1");
    const secondRelease = watch.acquirePrompt("chat1");
    const idle = watch.awaitChatIdle?.("chat1") ?? Promise.resolve();
    let resolved = false;
    void idle.then(() => {
      resolved = true;
    });
    watch.markPromptCompleted("chat1");
    watch.markPromptCompleted("chat1");
    firstRelease?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(false);
    secondRelease?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    watch.stop();
  });


  it("settles after the prompt result when SSE misses completion", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, acquirePrompt, markPromptCompleted, stop } = await client().watchSession("ses_1", vi.fn());
    const release = acquirePrompt("chat1");
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(false);

    markPromptCompleted();
    release?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(resolved).toBe(true);
    stop();
  });

  it("resets the hard ceiling after continuous activity", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 1);
    expect(resolved).toBe(true);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "watchSession",
      "hit max wait ceiling",
    ]);
    stop();
  });

  it("resets the ceiling from the latest relevant session event", async () => {
    const source = fakeEventSource();
    connectSource(source);
    const { awaitIdle, stop } = await client().watchSession("ses_1", vi.fn());
    let resolved = false;
    void awaitIdle().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 1);
    source.push(sessionIdle("ses_1"));
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 1);
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

  it("recovers text parts from the message endpoint after SSE reconnect", async () => {
    sessionMessage.mockResolvedValue(
      ok({ info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [{ type: "text", text: "recovered" }] }),
    );
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(assistantFinished("msg_1", "ses_1"));

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith("msg_1", "recovered");
    });
    expect(sessionMessage).toHaveBeenCalledWith({ path: { id: "ses_1", messageID: "msg_1" } });
    stop();
  });

  it("does not deliver when message recovery returns no data", async () => {
    sessionMessage.mockResolvedValue({ data: undefined, error: new Error("not found"), response: { status: 404 } });
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(assistantFinished("msg_1", "ses_1"));

    await vi.waitFor(() => {
      expect(sessionMessage).toHaveBeenCalled();
    });
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it("does not deliver an unrecoverable completed message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    sessionMessage.mockRejectedValue(new Error("message fetch down"));
    const source = fakeEventSource();
    connectSource(source);
    const onMessage = vi.fn();
    const { stop } = await client().watchSession("ses_1", onMessage);
    source.push(assistantFinished("msg_1", "ses_1"));

    await vi.waitFor(() => {
      expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
        "watchSession message recovery failed",
        "message fetch down",
      ]);
    });
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it("rejects when the initial SSE connection fails and cleans up timers", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    eventSubscribe.mockRejectedValue(new Error("connection reset"));
    await expect(client().watchSession("ses_1", vi.fn())).rejects.toThrow("connection reset");
    expect(vi.getTimerCount()).toBe(0);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "watchSession",
      "SSE subscription setup failed",
    ]);
  });

  it("times out when the actual SSE stream never connects", async () => {
    const source = fakeEventSource();
    connectSource(source, false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const watchPromise = client().watchSession("ses_1", vi.fn());
    const rejection = expect(watchPromise).rejects.toThrow("SSE connection timed out");
    await vi.advanceTimersByTimeAsync(SSE_CONNECT_TIMEOUT_MS);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "watchSession",
      "SSE connection setup timed out",
    ]);
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
    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["watchSession stream error", "dropped mid-stream"]);
    expect(logged).toContainEqual(["watchSession", "SSE stream ended"]);
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
