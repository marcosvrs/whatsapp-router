import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpencodeClient, OpencodeSendError, type OpencodeMediaAttachment } from "../src/integrations/opencode.js";
import { AgentExchangeManager, routeMessage, type RouterDeps } from "../src/router.js";
import { SenderLock } from "../src/senderLock.js";
import { SessionStore } from "../src/sessionStore.js";
import type { WahaClientLike } from "../src/waha/client.js";
import { TypingPresence } from "../src/waha/typingKeepAlive.js";
import { requestUrl } from "./testUtils.js";

const CHAT_ID = "chat1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

let dir: string;
let deps: RouterDeps;
let sentMessages: { chatId: string; text: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-router-test-"));
  const messages: { chatId: string; text: string }[] = [];
  sentMessages = messages;
  const waha: WahaClientLike = {
    sendText: vi.fn().mockImplementation((chatId: string, text: string) => {
      messages.push({ chatId, text });
      return Promise.resolve();
    }),
    startTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
    markChatRead: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    fetchGroups: vi.fn().mockResolvedValue({}),
    fetchSessionInfo: vi.fn().mockResolvedValue(null),
    downloadMedia: vi.fn().mockResolvedValue(null),
    fetchRecentMessages: vi.fn().mockResolvedValue([]),
  };
  deps = {
    opencode: new OpencodeClient({ baseUrl: "http://opencode.test", authHeader: "Basic abc", modelProvider: "", modelId: "" }),
    sessions: new SessionStore(join(dir, "sessions.json")),
    senderLock: new SenderLock(),
    typing: new TypingPresence(waha),
    exchanges: new AgentExchangeManager(),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function lastSentText(): string | undefined {
  return sentMessages.at(-1)?.text;
}

describe("routeMessage — /new", () => {
  it("resets the session and returns a confirmation when sent alone", async () => {
    deps.sessions.set("111", "ses_old");
    const reply = await routeMessage(deps, "111", CHAT_ID, "/new");
    expect(reply).toBe("Started a new conversation.");
    expect(deps.sessions.get("111")).toBeUndefined();
  });

  it("resets the session and forwards remaining text to the agent", async () => {
    deps.sessions.set("111", "ses_old");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "hi again" }] }));
      }),
    );

    await agentText(deps, "111", "/new hello");
    expect(lastSentText()).toBe("hi again");
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
});

// Drives the agent path and returns the last message sent to WhatsApp — the
// agent path no longer returns text directly (it can deliver more than one
// message over time via streaming), so tests observe delivery the same way
// server.ts would: via waha.sendText.
async function agentText(
  deps: RouterDeps,
  senderKey: string,
  text: string,
  media?: OpencodeMediaAttachment,
): Promise<string | undefined> {
  await routeMessage(deps, senderKey, CHAT_ID, text, media ? { media: [media] } : {});
  return lastSentText();
}

describe("routeMessage — default (agent)", () => {
  it("creates a session on first contact and sends the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "hello!" }] }));
      }),
    );

    const reply = await agentText(deps, "111", "hi there");
    expect(reply).toBe("hello!");
    expect(deps.sessions.get("111")).toBe("ses_1");
  });

  it("does not double-deliver when the SSE watch reports the same turn send() already returned", async () => {
    // Reproduces a real live-verification finding: watchSession is started
    // before send(), so both can observe the exact same completed turn —
    // delivery must dedupe by message id, not send twice.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        if (url.endsWith("/event")) {
          return Promise.resolve(
            sseResponse([
              {
                type: "message.part.updated",
                properties: {
                  part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello!" },
                },
              },
              {
                type: "message.updated",
                properties: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", finish: "stop" } },
              },
            ]),
          );
        }
        return Promise.resolve(jsonResponse({ info: { id: "msg_1" }, parts: [{ type: "text", text: "hello!" }] }));
      }),
    );

    await agentText(deps, "111", "hi there");
    expect(sentMessages.filter((m) => m.text === "hello!")).toHaveLength(1);
  });

  it("converts the agent's Markdown reply to WhatsApp formatting before returning it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(
          jsonResponse({ info: {}, parts: [{ type: "text", text: "This is **bold** and *italic*." }] }),
        );
      }),
    );

    const reply = await agentText(deps, "111", "hi there");
    expect(reply).toBe("This is *bold* and _italic_.");
  });

  it("reuses an existing session instead of creating a new one", async () => {
    deps.sessions.set("111", "ses_existing");
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      const url = requestUrl(input);
      if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await agentText(deps, "111", "hi again");

    const sessionCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].endsWith("/session"),
    );
    expect(sessionCalls).toHaveLength(0);
  });

  it("returns a friendly message when opencode isn't configured", async () => {
    deps.opencode = new OpencodeClient({ baseUrl: "http://opencode.test", authHeader: "", modelProvider: "", modelId: "" });
    const reply = await agentText(deps, "111", "hi");
    expect(reply).toBe("opencode agent not configured yet.");
  });

  it("leaves the stored session id untouched when it didn't change", async () => {
    deps.sessions.set("111", "ses_existing");
    const setSpy = vi.spyOn(deps.sessions, "set");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] }));
      }),
    );

    await agentText(deps, "111", "hi again");

    expect(setSpy).not.toHaveBeenCalled();
    expect(deps.sessions.get("111")).toBe("ses_existing");
  });

  it("replaces the stored session id when opencode recovers from a stale one", async () => {
    deps.sessions.set("111", "ses_stale");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        if (url.includes("/session/ses_stale/")) return Promise.resolve(jsonResponse({}, 404));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] }));
      }),
    );

    const reply = await agentText(deps, "111", "hi");

    expect(deps.sessions.get("111")).toBe("ses_new");
    expect(reply).not.toBe("Agent call failed — check whatsapp-router logs.");
  });

  it("returns a failure message and logs when the opencode call throws", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const reply = await agentText(deps, "111", "hi");
    expect(reply).toBe("Agent call failed — check whatsapp-router logs.");
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "opencode call failed",
      "network down",
    ]);
  });

  it("is case-insensitive and trims surrounding whitespace before forwarding to the agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "handled" }] }));
      }),
    );
    const sendSpy = vi.spyOn(deps.opencode, "send");
    const reply = await agentText(deps, "111", "  hello there  ");
    expect(reply).toBe("handled");
    expect(sendSpy).toHaveBeenCalledWith("ses_1", "hello there", expect.anything());
  });

  it("treats a bare '/new' prefix (e.g. '/newfoo') as agent text, not the reset command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "handled" }] }));
      }),
    );
    deps.sessions.set("111", "ses_untouched");
    const reply = await agentText(deps, "111", "/newfoo bar");
    expect(reply).toBe("handled");
    // "/new" only matches at a word boundary — session must NOT have been reset.
    expect(deps.sessions.get("111")).not.toBeUndefined();
  });

  it("forwards an attached image/document to the agent as a file part", async () => {
    const media: OpencodeMediaAttachment = { mimetype: "image/jpeg", dataBase64: "Zm9v" };
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return jsonResponse({ id: "ses_1" });
        if (url.endsWith("/event")) return jsonResponse({});
        capturedBody = JSON.parse(await (input as Request).clone().text()) as unknown;
        return jsonResponse({ info: {}, parts: [{ type: "text", text: "nice photo!" }] });
      }),
    );

    const reply = await agentText(deps, "111", "check this out", media);

    expect(reply).toBe("nice photo!");
    expect(capturedBody).toMatchObject({
      parts: [
        { type: "text", text: "check this out" },
        { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,Zm9v" },
      ],
    });
  });

  it("forwards media with no caption text as the only part", async () => {
    const media: OpencodeMediaAttachment = { mimetype: "application/pdf", dataBase64: "YmFy" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "got it" }] }));
      }),
    );

    const reply = await agentText(deps, "111", "", media);
    expect(reply).toBe("got it");
  });
});

describe("routeMessage — /new with media", () => {
  it("treats an empty media array the same as no media at all (bare '/new' resets, no agent call)", async () => {
    deps.sessions.set("111", "ses_old");
    const reply = await routeMessage(deps, "111", CHAT_ID, "/new", { media: [] });
    expect(reply).toBe("Started a new conversation.");
  });

  it("forwards to the agent (instead of the plain reset confirmation) when media is attached without trailing text", async () => {
    const media: OpencodeMediaAttachment = { mimetype: "image/jpeg", dataBase64: "Zm9v" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "new session, got it" }] }));
      }),
    );
    deps.sessions.set("111", "ses_old");

    const reply = await agentText(deps, "111", "/new", media);

    expect(reply).toBe("new session, got it");
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
});

describe("routeMessage — agent context", () => {
  function captureSystem(finalReply = "ok"): { body: () => unknown } {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return jsonResponse({ id: "ses_1" });
        if (url.endsWith("/event")) return jsonResponse({});
        capturedBody = JSON.parse(await (input as Request).clone().text()) as unknown;
        return jsonResponse({ info: {}, parts: [{ type: "text", text: finalReply }] });
      }),
    );
    return { body: () => capturedBody };
  }

  it("formats a 1:1-chat system context with the sender's name and phone", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: {
        senderName: "Alex Test",
        senderPhone: "111",
        isGroupChat: false,
      },
    });

    expect(lastSentText()).toBe("ok");
    expect(capture.body()).toMatchObject({
      system:
        "You are being reached over WhatsApp.\n" +
        "Message from: Alex Test (+111)\n" +
        "Chat: a direct message (not a group)",
    });
  });

  it("formats a group-chat system context with the group's name", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: {
        senderName: "Alex",
        senderPhone: "111",
        isGroupChat: true,
        groupName: "Jarvis Test",
      },
    });

    expect(capture.body()).toMatchObject({
      system:
        "You are being reached over WhatsApp.\n" +
        "Message from: Alex (+111)\n" +
        'Chat: a group named "Jarvis Test"',
    });
  });

  it("falls back to just the phone number when the sender's push name is unavailable", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: { senderPhone: "111", isGroupChat: false },
    });

    expect(capture.body()).toMatchObject({
      system: expect.stringContaining("Message from: +111\n") as string,
    });
  });

  it("says just 'a group' when the group has no known name", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: { senderPhone: "111", isGroupChat: true },
    });

    const body = capture.body() as { system: string };
    expect(body.system.split("\n")).toContain("Chat: a group");
  });

  it("includes the send timestamp as an ISO string when provided", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: {
        senderPhone: "111",
        isGroupChat: false,
        timestamp: 1786019629,
      },
    });

    expect(capture.body()).toMatchObject({
      system: expect.stringContaining("Sent at: 2026-08-06T12:33:49.000Z") as string,
    });
  });

  it("includes the replied-to message's text when present", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: {
        senderPhone: "111",
        isGroupChat: false,
        replyToText: "What time works for you?",
      },
    });

    expect(capture.body()).toMatchObject({
      system: expect.stringContaining(
        'Replying to an earlier message: "What time works for you?"',
      ) as string,
    });
  });

  it("omits the system field entirely when no context is given", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi");

    const body = capture.body() as { system?: unknown };
    expect(body.system).toBeUndefined();
  });

  it("includes a shared location when present", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: {
        senderPhone: "111",
        isGroupChat: false,
        locationText: "Our office (38.8937255, -77.0969763)",
      },
    });

    expect(capture.body()).toMatchObject({
      system: expect.stringContaining(
        "Shared location: Our office (38.8937255, -77.0969763)",
      ) as string,
    });
  });

  it("includes recent group history when present", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: {
        senderPhone: "111",
        isGroupChat: true,
        recentMessages: "Alex: How much is it?\nSisyphus: It's 4.",
      },
    });

    const system = (capture.body() as { system: string }).system;
    expect(system).toContain("Recent messages in this group");
    expect(system).toContain("Alex: How much is it?\nSisyphus: It's 4.");
  });

  it("omits the recent-history line when not present", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", CHAT_ID, "hi", {
      context: { senderPhone: "111", isGroupChat: false },
    });

    const system = (capture.body() as { system: string }).system;
    expect(system).not.toContain("Recent messages");
  });

  it("routes a bare /new with only a shared location to the agent instead of resetting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        if (url.endsWith("/event")) return Promise.resolve(jsonResponse({}));
        return Promise.resolve(
          jsonResponse({ info: {}, parts: [{ type: "text", text: "got your location" }] }),
        );
      }),
    );
    deps.sessions.set("111", "ses_old");

    await routeMessage(deps, "111", CHAT_ID, "/new", {
      context: { senderPhone: "111", isGroupChat: false, locationText: "1.5, 2.5" },
    });

    expect(lastSentText()).toBe("got your location");
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
  it("releases the sender lock after the prompt result while background watching continues", async () => {
    deps.sessions.set("111", "ses_1");
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const releasePrompt = vi.fn();
    const acquirePrompt = vi.fn(() => releasePrompt);
    const markPromptCompleted = vi.fn();
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      awaitIdle: () => done,
      acquirePrompt,
      markPromptCompleted,
      stop: vi.fn(),
    });
    const sendSpy = vi.spyOn(deps.opencode, "send").mockImplementation((_sessionId, text) =>
      Promise.resolve({
        sessionId: "ses_1",
        reply: text,
        messageId: text,
      }),
    );

    const first = routeMessage(deps, "111", CHAT_ID, "first");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
    const second = routeMessage(deps, "111", CHAT_ID, "second");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    release();
    await Promise.all([first, second]);
    expect(acquirePrompt).toHaveBeenCalledTimes(2);
    expect(markPromptCompleted).toHaveBeenCalledTimes(2);
    expect(releasePrompt).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenNthCalledWith(
      1,
      "ses_1",
      "first",
      expect.objectContaining({ media: undefined }),
    );
    expect(sendSpy).toHaveBeenNthCalledWith(
      2,
      "ses_1",
      "second",
      expect.objectContaining({ media: undefined }),
    );
  });
  it("delivers reused exchange replies to the latest destination chat", async () => {
    deps.sessions.set("111", "ses_1");
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      awaitIdle: () => done,
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });
    const sendSpy = vi.spyOn(deps.opencode, "send").mockImplementation((_sessionId, text) =>
      Promise.resolve({ sessionId: "ses_1", reply: text, messageId: text }),
    );

    const first = routeMessage(deps, "111", "chat1", "first");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
    const second = routeMessage(deps, "111", "chat2", "second");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(sentMessages).toHaveLength(2);
    });

    expect(sentMessages).toEqual([
      { chatId: "chat1", text: "first" },
      { chatId: "chat2", text: "second" },
    ]);
    release();
    await Promise.all([first, second]);
  });

  it("does not let an old finalizer delete a same-session replacement", async () => {
    const manager = new AgentExchangeManager();
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstWatch = {
      awaitIdle: () => firstDone,
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    const secondWatch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(firstWatch)
      .mockResolvedValueOnce(secondWatch);

    const first = await manager.acquire(deps, "111", "ses_1", "chat1");
    first.exchange.stop();
    const second = await manager.acquire(deps, "111", "ses_1", "chat2");
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();

    const current = await manager.acquire(deps, "111", "ses_1", "chat2");
    expect(current.created).toBe(false);
    first.release();
    second.release();
    current.release();
    manager.stop("111", second.exchange);
  });

  it("does not stop the current exchange when an old exchange is supplied", async () => {
    const manager = new AgentExchangeManager();
    const firstStop = vi.fn();
    const currentStop = vi.fn();
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: currentStop,
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const first = await manager.acquire(deps, "111", "ses_1", "chat1");
    const staleExchange = { ...first.exchange, stop: firstStop };
    manager.stop("111", staleExchange);
    expect(firstStop).not.toHaveBeenCalled();
    expect(currentStop).not.toHaveBeenCalled();
    manager.stop("111", first.exchange);
    expect(currentStop).toHaveBeenCalledTimes(1);
  });
  it("keeps streamed turns in their originating chat", async () => {
    deps.sessions.set("111", "ses_1");
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onTurn!: (messageId: string, text: string, chatId?: string) => void;
    const watch = {
      awaitIdle: () => done,
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockImplementation((_sessionId, callback) => {
      onTurn = callback;
      return Promise.resolve(watch);
    });
    const sendSpy = vi.spyOn(deps.opencode, "send").mockImplementation((_sessionId, text) =>
      Promise.resolve({ sessionId: "ses_1", reply: text, messageId: text }),
    );

    const first = routeMessage(deps, "111", "direct", "first");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
    onTurn("background-direct", "private background", "direct");
    await vi.waitFor(() => {
      expect(sentMessages).toContainEqual({ chatId: "direct", text: "private background" });
    });

    const second = routeMessage(deps, "111", "group", "second");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });
    onTurn("background-group", "group background", "group");
    await vi.waitFor(() => {
      expect(sentMessages).toContainEqual({ chatId: "group", text: "group background" });
    });

    release();
    await Promise.all([first, second]);
  });

  it("retries a delivery when the first attempt fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const send = vi
      .spyOn(deps.typing, "send")
      .mockRejectedValueOnce(new Error("temporary WAHA failure"))
      .mockResolvedValue(undefined);
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockImplementation(() => Promise.resolve(watch));
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("msg_1", "reply", "chat1");
    acquired.exchange.deliver("msg_1", "reply", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenNthCalledWith(1, "chat1", "reply");
      expect(send).toHaveBeenNthCalledWith(2, "chat1", "reply");
    });
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "failed to deliver agent turn",
      "temporary WAHA failure",
    ]);
    manager.stop("111", acquired.exchange);
  });

  it("does not retry a delivery failure when no fallback turn exists", async () => {
    const send = vi.spyOn(deps.typing, "send").mockRejectedValue(new Error("permanent WAHA failure"));
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("msg_1", "reply", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    manager.stop("111", acquired.exchange);
  });

  it("keeps a created watcher after an ambiguous prompt failure", async () => {
    deps.sessions.set("111", "ses_1");
    let releaseDone!: () => void;
    const done = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    const stop = vi.fn();
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      awaitIdle: () => done,
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop,
    });
    const send = vi.spyOn(deps.opencode, "send").mockRejectedValue(new Error("connection reset"));

    const route = routeMessage(deps, "111", CHAT_ID, "hi");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await route;
    expect(stop).not.toHaveBeenCalled();

    releaseDone();
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  it("starts the replacement watcher before a stale-session retry", async () => {
    deps.sessions.set("111", "ses_stale");
    const watchedSessions: string[] = [];
    const watch = {
      awaitIdle: () => Promise.resolve(),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockImplementation((sessionId) => {
      watchedSessions.push(sessionId);
      return Promise.resolve(watch);
    });
    const send = vi.spyOn(deps.opencode, "send").mockImplementation((_sessionId, text, options) => {
      const replacement = options?.onSessionReplaced?.("ses_new") ?? Promise.resolve();
      return replacement.then(() => ({ sessionId: "ses_new", reply: text, messageId: "msg_1" }));
    });

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(send).toHaveBeenCalledTimes(1);
    expect(watchedSessions).toEqual(["ses_stale", "ses_new"]);
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
  it("deduplicates a delivered message after the first send succeeds", async () => {
    const send = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    const watch = {
      awaitIdle: () => Promise.resolve(),
      acquirePrompt: () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockImplementation(() => Promise.resolve(watch));
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", CHAT_ID);

    acquired.exchange.deliver("msg_1", "reply", CHAT_ID);
    acquired.exchange.deliver("msg_1", "reply", CHAT_ID);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    acquired.exchange.deliver("msg_1", "reply", CHAT_ID);
    expect(send).toHaveBeenCalledTimes(1);
    acquired.release();
    manager.stop("111", acquired.exchange);
  });

  it("replaces a watcher when a reused session cannot acquire a prompt lease", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => undefined,
      markPromptCompleted: vi.fn(),
      stop: firstStop,
    };
    const replacementWatch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => undefined,
      markPromptCompleted: vi.fn(),
      stop: secondStop,
    };
    vi.spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(watch)
      .mockResolvedValueOnce(replacementWatch);
    const manager = new AgentExchangeManager();
    await manager.acquire(deps, "111", "ses_1", CHAT_ID);
    const second = await manager.acquire(deps, "111", "ses_1", "chat2");

    expect(second.created).toBe(true);
    expect(firstStop).toHaveBeenCalledTimes(1);
    manager.stop("111", second.exchange);
  });

  it("cancels a pending destination for a known prompt rejection", async () => {
    deps.sessions.set("111", "ses_1");
    const releasePrompt = vi.fn();
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => releasePrompt,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });
    vi.spyOn(deps.opencode, "send").mockRejectedValue(new OpencodeSendError(500));

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(releasePrompt).toHaveBeenCalledWith(true);
  });

  it("replaces the watcher when a send result reports a new session", async () => {
    deps.sessions.set("111", "ses_stale");
    const watchedSessions: string[] = [];
    const watch = {
      awaitIdle: () => Promise.resolve(),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockImplementation((sessionId) => {
      watchedSessions.push(sessionId);
      return Promise.resolve(watch);
    });
    vi.spyOn(deps.opencode, "send").mockResolvedValue({
      sessionId: "ses_new",
      reply: "ok",
      messageId: "msg_1",
    });

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(watchedSessions).toEqual(["ses_stale", "ses_new"]);
  });
});
