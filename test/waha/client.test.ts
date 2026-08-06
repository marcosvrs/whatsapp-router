import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "../../src/waha/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WahaClient.sendText", () => {
  it("posts to /api/sendText with the exact method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendText("111@c.us", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/sendText");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Api-Key": "key123",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      session: "MySession",
      chatId: "111@c.us",
      text: "hello",
    });
  });

  it("logs the status and response body when the send fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await expect(client.sendText("111@c.us", "hello")).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const args = logSpy.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(["sendText failed", 500, "oops"]);
  });

  it("does not log anything on a successful send", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 201 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendText("111@c.us", "hello");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("falls back to an empty string when reading the failure body itself rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const badResponse = new Response(null, { status: 500 });
    vi.spyOn(badResponse, "text").mockRejectedValue(new Error("stream error"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badResponse));

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendText("111@c.us", "hello");

    const args = logSpy.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(["sendText failed", 500, ""]);
  });
});

describe("WahaClient.fetchGroups", () => {
  it("requests the session-scoped groups endpoint with the api key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.fetchGroups();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/MySession/groups");
    expect(init.headers).toEqual({ "X-Api-Key": "key123" });
  });

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
  it("requests the sessions endpoint with the api key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({})));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.fetchSessionInfo();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/sessions/MySession");
    expect(init.headers).toEqual({ "X-Api-Key": "key123" });
  });

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
