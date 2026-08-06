import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreate = vi.fn();
const sessionPrompt = vi.fn();
const createOpencodeClient = vi.fn(() => ({
  session: { create: sessionCreate, prompt: sessionPrompt },
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
  createOpencodeClient.mockClear();
});

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
      mimetype: "image/jpeg",
      dataBase64: "Zm9v",
      filename: "photo.jpg",
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
      mimetype: "application/pdf",
      dataBase64: "YmFy",
    });

    expect(sessionPrompt).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      body: {
        parts: [{ type: "file", mime: "application/pdf", filename: undefined, url: "data:application/pdf;base64,YmFy" }],
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
