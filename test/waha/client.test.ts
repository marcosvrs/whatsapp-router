import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "../../src/waha/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WahaClient.sendText", () => {
  it("posts to /api/sendText with the session, chatId and text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendText("111@c.us", "hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/sendText");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("key123");
    expect(JSON.parse(init.body as string)).toEqual({
      session: "MySession",
      chatId: "111@c.us",
      text: "hello",
    });
  });

  it("does not throw when the send fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await expect(client.sendText("111@c.us", "hello")).resolves.toBeUndefined();
  });
});

describe("WahaClient.fetchGroups", () => {
  it("returns the parsed groups on success", async () => {
    const groups = { g1: { participants: [{ id: "1@lid", phoneNumber: "111@c.us" }] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(groups))));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    expect(await client.fetchGroups()).toEqual(groups);
  });

  it("returns an empty object on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    expect(await client.fetchGroups()).toEqual({});
  });
});

describe("WahaClient.fetchSessionInfo", () => {
  it("returns the parsed session info on success", async () => {
    const info = { me: { id: "555@c.us", lid: "777@lid" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(info))));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    expect(await client.fetchSessionInfo()).toEqual(info);
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    expect(await client.fetchSessionInfo()).toBeNull();
  });
});
