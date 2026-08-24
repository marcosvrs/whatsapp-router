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

  it("includes the pre-generated id in the body when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendText("111@c.us", "hello", "MYID123");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      session: "MySession",
      chatId: "111@c.us",
      text: "hello",
      id: "MYID123",
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

describe("WahaClient.startTyping", () => {
  it("posts to /api/startTyping with the session and chatId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.startTyping("111@c.us");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/startTyping");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Api-Key": "key123" });
    expect(JSON.parse(init.body as string)).toEqual({ session: "MySession", chatId: "111@c.us" });
  });

  it("passes an abort signal through to startTyping when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new WahaClient("http://waha.test", "key123", "MySession").startTyping("111@c.us", signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(signal);
  });

  it("logs on failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.startTyping("111@c.us");
    expect(logSpy.mock.calls[0]?.slice(1)).toEqual(["startTyping failed", 500, "oops"]);
  });
});

describe("WahaClient.stopTyping", () => {
  it("posts to /api/stopTyping with the session and chatId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.stopTyping("111@c.us");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/stopTyping");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Api-Key": "key123" });
    expect(JSON.parse(init.body as string)).toEqual({ session: "MySession", chatId: "111@c.us" });
  });

  it("logs on failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.stopTyping("111@c.us");
    expect(logSpy.mock.calls[0]?.slice(1)).toEqual(["stopTyping failed", 500, "oops"]);
  });
});

describe("WahaClient.markChatRead", () => {
  it("posts to the session-scoped read endpoint, URL-encoding the chat id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.markChatRead("111@c.us");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/MySession/chats/111%40c.us/messages/read");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("logs on failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.markChatRead("111@c.us");
    expect(logSpy.mock.calls[0]?.slice(1)).toEqual(["markChatRead failed", 500, "oops"]);
  });
});

describe("WahaClient.sendReaction", () => {
  it("PUTs to /api/reaction with the session, messageId, and reaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendReaction("msg_1", "✅");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/reaction");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      session: "MySession",
      messageId: "msg_1",
      reaction: "✅",
    });
  });

  it("logs on failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.sendReaction("msg_1", "✅");
    expect(logSpy.mock.calls[0]?.slice(1)).toEqual(["sendReaction failed", 500, "oops"]);
  });
});

describe("WahaClient.editMessage", () => {
  // WAHA's own message ids are composite (confirmed against a live message:
  // "true_<chatId>_<rawId>") — editMessage only ever targets a message this
  // client itself just sent (WhatsApp doesn't allow editing others'
  // messages), so fromMe is always "true". The raw id passed in is the same
  // one given to sendText's `id` field.
  it("PUTs to the fromMe-prefixed composite message id, URL-encoding chat id and the whole id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.editMessage("111@c.us", "ABC123", "updated text");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://waha.test/api/MySession/chats/111%40c.us/messages/true_111%40c.us_ABC123",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ text: "updated text" });
  });

  it("logs on failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.editMessage("111@c.us", "msg_1", "text");
    expect(logSpy.mock.calls[0]?.slice(1)).toEqual(["editMessage failed", 500, "oops"]);
  });
});

describe("WahaClient.downloadMedia", () => {
  it("fetches the given url with the api key header and returns base64-encoded bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    const result = await client.downloadMedia("http://waha.test/api/files/abc.jpg");

    expect(result).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/files/abc.jpg");
    expect(init.headers).toEqual({ "X-Api-Key": "key123" });
  });

  // WAHA can self-report media.url with the wrong host for this deployment
  // (e.g. "http://localhost:3000/..." — meaningless from inside a different
  // container). Trust this client's own configured baseUrl for the origin;
  // only take the path from the url WAHA gave us.
  it("rewrites the url's origin to this client's own baseUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.downloadMedia("http://localhost:3000/api/files/Jarvis/abc.jpeg");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://waha.test/api/files/Jarvis/abc.jpeg");
  });

  it("returns null and logs on a non-ok response", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    const result = await client.downloadMedia("http://waha.test/api/files/abc.jpg");

    expect(result).toBeNull();
    const args = logSpy.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(["downloadMedia failed", 500, "oops"]);
  });

  it("returns null and logs when the fetch itself rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    const result = await client.downloadMedia("http://waha.test/api/files/abc.jpg");

    expect(result).toBeNull();
    const args = logSpy.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(["downloadMedia failed", "network down"]);
  });

  it("falls back to an empty string when reading the failure body itself rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const badResponse = new Response(null, { status: 500 });
    vi.spyOn(badResponse, "text").mockRejectedValue(new Error("stream error"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(badResponse));

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    const result = await client.downloadMedia("http://waha.test/api/files/abc.jpg");

    expect(result).toBeNull();
    const args = logSpy.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(["downloadMedia failed", 500, ""]);
  });

  it("stringifies a non-Error rejection", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("connection reset"));

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    const result = await client.downloadMedia("http://waha.test/api/files/abc.jpg");

    expect(result).toBeNull();
    const args = logSpy.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual(["downloadMedia failed", "connection reset"]);
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

describe("WahaClient.fetchRecentMessages", () => {
  it("requests the chat-history endpoint with limit, downloadMedia=false, and the api key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([])));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WahaClient("http://waha.test", "key123", "MySession");
    await client.fetchRecentMessages("123@g.us", 25);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://waha.test/api/MySession/chats/123%40g.us/messages?limit=25&downloadMedia=false",
    );
    expect(init.headers).toEqual({ "X-Api-Key": "key123" });
  });

  it("returns the parsed messages on success", async () => {
    const messages = [{ id: "m1", body: "hi" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(messages))));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    expect(await client.fetchRecentMessages("123@g.us", 25)).toEqual(messages);
  });

  it("returns an empty array on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const client = new WahaClient("http://waha.test", "key123", "MySession");
    expect(await client.fetchRecentMessages("123@g.us", 25)).toEqual([]);
  });
});
