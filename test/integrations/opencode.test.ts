import { afterEach, describe, expect, it, vi } from "vitest";
import { OpencodeClient } from "../../src/integrations/opencode.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpencodeClient.isConfigured", () => {
  it("is false without an auth header", () => {
    expect(new OpencodeClient("http://oc.test", "", "", "", true).isConfigured()).toBe(false);
  });

  it("is true with an auth header", () => {
    expect(new OpencodeClient("http://oc.test", "Basic abc", "", "", true).isConfigured()).toBe(
      true,
    );
  });
});

describe("OpencodeClient.createSession", () => {
  it("includes an auto-approve-all permission ruleset when autoApprove is true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "ses_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", true);
    const id = await client.createSession();

    expect(id).toBe("ses_1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { permission?: unknown[] };
    expect(body.permission).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  it("sends no permission override when autoApprove is false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "ses_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", false);
    await client.createSession();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("throws when session creation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", true);
    await expect(client.createSession()).rejects.toThrow("session create failed: 500");
  });
});

describe("OpencodeClient.send", () => {
  it("returns the concatenated text parts of a successful reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          parts: [
            { type: "text", text: "hello" },
            { type: "step-finish" },
            { type: "text", text: "world" },
          ],
        }),
      ),
    );
    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", true);
    const result = await client.send("ses_1", "hi");
    expect(result).toEqual({ sessionId: "ses_1", reply: "hello\nworld" });
  });

  it("returns a placeholder when there are no text parts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ parts: [] })));
    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", true);
    const result = await client.send("ses_1", "hi");
    expect(result.reply).toBe("(no output)");
  });

  it("formats an agent error from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ info: { error: { data: { message: "Insufficient balance." } } } }),
      ),
    );
    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", true);
    const result = await client.send("ses_1", "hi");
    expect(result.reply).toBe("Agent error: Insufficient balance.");
  });

  it("creates a fresh session and retries once on a 404 (stale session)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({ id: "ses_new" }))
      .mockResolvedValueOnce(jsonResponse({ parts: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpencodeClient("http://oc.test", "Basic abc", "", "", true);
    const result = await client.send("ses_stale", "hi");

    expect(result).toEqual({ sessionId: "ses_new", reply: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("includes a model override when provider and id are both set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ parts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpencodeClient("http://oc.test", "Basic abc", "openai", "gpt-5.6-luna", true);
    await client.send("ses_1", "hi");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model?: unknown };
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" });
  });
});
