import { afterEach, describe, expect, it, vi } from "vitest";
import { HaClient } from "../../src/integrations/homeAssistant.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HaClient", () => {
  it("reports not configured when the webhook id is missing", async () => {
    const client = new HaClient("http://ha.test", "token", "");
    expect(client.isConfigured()).toBe(false);
    expect(await client.trigger("hi")).toEqual({
      ok: false,
      text: "Home Assistant webhook not configured yet.",
    });
  });

  it("reports not configured when the token is missing", () => {
    const client = new HaClient("http://ha.test", "", "hook123");
    expect(client.isConfigured()).toBe(false);
  });

  it("posts to the webhook url with the bearer token and returns success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HaClient("http://ha.test", "token123", "hook123");
    const reply = await client.trigger("turn on lights");

    expect(reply).toEqual({ ok: true, text: "Sent to Home Assistant." });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ha.test/api/webhook/hook123");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token123");
    expect(JSON.parse(init.body as string)).toEqual({ text: "turn on lights" });
  });

  it("returns a failure message with the status code on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const client = new HaClient("http://ha.test", "token", "hook123");
    expect(await client.trigger("hi")).toEqual({ ok: false, text: "HA webhook failed (500)." });
  });
});
