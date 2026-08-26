import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpencodeClient, OpencodeSendError, type OpencodeMediaAttachment } from "../src/integrations/opencode.js";
import { DeliveryRetryStore } from "../src/deliveryRetryStore.js";
import { AgentExchangeManager, routeMessage, type RouterDeps } from "../src/router.js";
import { SenderLock } from "../src/senderLock.js";
import { SessionStore } from "../src/sessionStore.js";
import type { WahaClientLike } from "../src/waha/client.js";
import { TypingPresence } from "../src/waha/typingKeepAlive.js";
import { getLogLevel, setLogLevel } from "../src/log.js";
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
    deliveryRetries: new DeliveryRetryStore(join(dir, "delivery-retries.json")),
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
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "stale",
      text: "stale reply",
      chatId: CHAT_ID,
      attempts: 0,
    });
    const reply = await routeMessage(deps, "111", CHAT_ID, "/new");
    expect(reply).toBe("Started a new conversation.");
    expect(deps.sessions.get("111")).toBeUndefined();
    expect(deps.deliveryRetries.list("111")).toEqual([]);
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

  it("shows a failure when no live watcher can retain the prompt", async () => {
    deps.sessions.set("111", "ses_1");
    vi.spyOn(deps.opencode, "watchSession").mockRejectedValue(new Error("watch unavailable"));
    vi.spyOn(deps.opencode, "send").mockRejectedValue(new Error("network down"));
    const sendNotice = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(sendNotice).toHaveBeenCalledWith(CHAT_ID, "Agent call failed — check whatsapp-router logs.");
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
  it("correlates successful prompt destinations before another chat can claim them", async () => {
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
        userMessageId: `user_${text}`,
      }),
    );

    const first = routeMessage(deps, "111", "chat1", "first");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
    const second = routeMessage(deps, "111", "chat2", "second");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    release();
    await Promise.all([first, second]);
    expect(sentMessages).toEqual([
      { chatId: "chat1", text: "first" },
      { chatId: "chat2", text: "second" },
    ]);
    expect(acquirePrompt).toHaveBeenCalledTimes(2);
    expect(markPromptCompleted).toHaveBeenCalledTimes(2);
    expect(releasePrompt).toHaveBeenNthCalledWith(1, false, "user_first");
    expect(releasePrompt).toHaveBeenNthCalledWith(2, false, "user_second");
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

    let firstDone = false;
    const first = routeMessage(deps, "111", "chat1", "first").then(() => {
      firstDone = true;
    });
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
    await second;
    expect(firstDone).toBe(false);
    release();
    await first;
  });

  it("replays a persisted delivery after exchange recovery", async () => {
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "persisted-message",
      text: "recovered reply",
      chatId: "chat-recovered",
      attempts: 1,
    });
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });

    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");
    await vi.waitFor(() => {
      expect(sentMessages).toEqual([{ chatId: "chat-recovered", text: "recovered reply" }]);
    });
    expect(deps.deliveryRetries.list("111")).toEqual([]);
    acquired.exchange.stop();
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

  it("drops an unmapped streamed turn instead of using the watcher's first chat", async () => {
    deps.sessions.set("111", "ses_1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onTurn!: (messageId: string, text: string, chatId?: string) => void;
    vi.spyOn(deps.opencode, "watchSession").mockImplementation((_sessionId, callback) => {
      onTurn = callback;
      return Promise.resolve({
        awaitIdle: () => done,
        acquirePrompt: () => () => undefined,
        markPromptCompleted: vi.fn(),
        stop: vi.fn(),
      });
    });
    const sendSpy = vi.spyOn(deps.opencode, "send").mockResolvedValue({
      sessionId: "ses_1",
      reply: "authoritative",
      messageId: "authoritative",
    });

    const route = routeMessage(deps, "111", "direct", "prompt");
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
    onTurn("streamed", "must not go to the first chat");

    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "discarding unmapped agent turn",
      "streamed",
    ]);
    expect(sentMessages).not.toContainEqual({ chatId: "direct", text: "must not go to the first chat" });

    release();
    await route;
    expect(sentMessages).toEqual([{ chatId: "direct", text: "authoritative" }]);
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
      expect(send).toHaveBeenNthCalledWith(1, "chat1", "reply", "msg_1", expect.any(AbortSignal));
      expect(send).toHaveBeenNthCalledWith(2, "chat1", "reply", "msg_1", expect.any(AbortSignal));
    });
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    const tails = (manager as unknown as { deliveryTails: Map<string, Promise<void>> }).deliveryTails;
    expect(tails.has("chat1")).toBe(false);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "failed to deliver agent turn",
      "temporary WAHA failure",
    ]);
    manager.stop("111", acquired.exchange);
  });

  it("keeps a failed turn ahead of later queued turns", async () => {
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
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("first", "first reply", "chat1");
    acquired.exchange.deliver("second", "second reply", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(3);
    });

    expect(send.mock.calls.map((call) => call[2])).toEqual(["first", "first", "second"]);
    manager.stop("111", acquired.exchange);
  });

  it("persists a pending fallback while the first delivery is in flight", async () => {
    let releaseFirst!: () => void;
    const send = vi.spyOn(deps.typing, "send").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("fallback", "first reply", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(deps.deliveryRetries.list("111")).toEqual([
      {
        senderKey: "111",
        messageId: "fallback",
        text: "first reply",
        chatId: "chat1",
        attempts: 0,
      },
    ]);
    acquired.exchange.deliver("fallback", "authoritative reply", "chat1");
    expect(deps.deliveryRetries.list("111")).toEqual([
      {
        senderKey: "111",
        messageId: "fallback",
        text: "authoritative reply",
        chatId: "chat1",
        attempts: 0,
      },
    ]);
    releaseFirst();
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    acquired.exchange.stop();
  });

  it("persists retry attempts before retrying a failed delivery", async () => {
    let releaseRetry!: () => void;
    const send = vi
      .spyOn(deps.typing, "send")
      .mockRejectedValueOnce(new Error("temporary WAHA failure"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseRetry = resolve;
          }),
      );
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("retry-state", "reply", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(deps.deliveryRetries.list("111")).toEqual([
      {
        senderKey: "111",
        messageId: "retry-state",
        text: "reply",
        chatId: "chat1",
        attempts: 1,
      },
    ]);
    releaseRetry();
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    acquired.exchange.stop();
  });

  it("cancels an in-flight delivery when its exchange stops", async () => {
    const send = vi.spyOn(deps.typing, "send").mockImplementation(
      (_chatId, _text, _messageId, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("in-flight", "old reply", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    manager.stop("111", acquired.exchange);
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    expect(send).toHaveBeenCalledTimes(1);
    const controllers = manager as unknown as {
      deliveryControllers: Map<string, Set<AbortController>>;
    };
    expect(controllers.deliveryControllers.size).toBe(0);
  });
  it("drains persisted deliveries without waiting for a new prompt", async () => {
    const send = vi
      .spyOn(deps.typing, "send")
      .mockRejectedValueOnce(new Error("temporary WAHA failure"))
      .mockResolvedValue(undefined);
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "startup-message",
      text: "startup reply",
      chatId: "chat1",
      attempts: 0,
    });
    const manager = new AgentExchangeManager();

    manager.drainPersistedDeliveries(deps);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send.mock.calls.map((call) => call[2])).toEqual(["startup-message", "startup-message"]);
    expect(deps.deliveryRetries.list("111")).toEqual([]);
  });

  it("continues later delivery work after an unexpected queue rejection", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const manager = new AgentExchangeManager();
    const queue = manager as unknown as {
      queueDelivery: (chatId: string, task: () => Promise<void>) => void;
    };

    queue.queueDelivery("chat1", () => Promise.reject(new Error("queue failure")));
    queue.queueDelivery("chat1", () => Promise.resolve());
    queue.queueDelivery("chat2", () => Promise.reject(new Error("final queue failure")));
    const internals = manager as unknown as {
      deliveryTails: Map<string, Promise<void>>;
    };
    const chat1Tail = (internals.deliveryTails.get("chat1") ?? Promise.resolve()).catch(() => undefined);
    const chat2Tail = (internals.deliveryTails.get("chat2") ?? Promise.resolve()).catch(() => undefined);
    await Promise.all([chat1Tail, chat2Tail]);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "delivery queue failed",
      "queue failure",
    ]);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "delivery queue failed",
      "final queue failure",
    ]);
    expect(internals.deliveryTails.has("chat1")).toBe(false);
    expect(internals.deliveryTails.has("chat2")).toBe(false);
  });

  it("drops a queued delivery when its exchange is stopped before dispatch", async () => {
    const send = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    acquired.exchange.deliver("queued", "old reply", "chat1");
    manager.stop("111", acquired.exchange);
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not duplicate a delivery already queued for startup drain", async () => {
    let release!: () => void;
    const send = vi.spyOn(deps.typing, "send").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "startup-once",
      text: "startup reply",
      chatId: "chat1",
      attempts: 0,
    });
    const manager = new AgentExchangeManager();

    manager.drainPersistedDeliveries(deps);
    manager.drainPersistedDeliveries(deps);
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
      expect(deps.deliveryRetries.list("111")).toHaveLength(1);
    });
    release();
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    acquired.exchange.stop();
  });

  it("removes an exhausted persisted delivery during startup drain", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const send = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "startup-exhausted",
      text: "startup reply",
      chatId: "chat1",
      attempts: 2,
    });
    const manager = new AgentExchangeManager();

    manager.drainPersistedDeliveries(deps);
    await vi.waitFor(() => {
      expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
        "agent turn delivery retries exhausted",
        "startup-exhausted",
      ]);
    });
    expect(send).not.toHaveBeenCalled();
    expect(deps.deliveryRetries.list("111")).toEqual([]);
  });

  it("cancels an in-flight startup delivery when its sender stops", async () => {
    const send = vi.spyOn(deps.typing, "send").mockImplementation(
      (_chatId, _text, _messageId, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "startup-in-flight",
      text: "startup reply",
      chatId: "chat1",
      attempts: 0,
    });
    const manager = new AgentExchangeManager();

    manager.drainPersistedDeliveries(deps);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    manager.stop("111");
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    expect((manager as unknown as { deliveryControllers: Map<string, Set<AbortController>> }).deliveryControllers.size).toBe(0);
  });
  it("clears a startup delivery canceled before dispatch", async () => {
    const send = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    deps.deliveryRetries.set({
      senderKey: "111",
      messageId: "startup-canceled",
      text: "startup reply",
      chatId: "chat1",
      attempts: 0,
    });
    const manager = new AgentExchangeManager();

    manager.drainPersistedDeliveries(deps);
    manager.stop("111");
    await vi.waitFor(() => {
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    expect(send).not.toHaveBeenCalled();
  });


  it("bounds delivery retries when no fallback turn exists", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "agent turn delivery retries exhausted",
      "msg_1",
    ]);
    manager.stop("111", acquired.exchange);
  });
  it("drops deliveries from an exchange invalidated by /new", async () => {
    const send = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", "chat1");

    expect(manager.bumpGeneration("111")).toBe(1);
    acquired.exchange.deliver("stale", "old reply", "chat1");
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    manager.stop("111", acquired.exchange);
  });

  it("keeps a created watcher after an ambiguous prompt failure", async () => {
    deps.sessions.set("111", "ses_1");
    let releaseDone!: () => void;
    const done = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    const stop = vi.fn();
    const sendNotice = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    const endTyping = vi.spyOn(deps.typing, "end");
    const releasePrompt = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      isLive: true,
      awaitIdle: () => done,
      acquirePrompt: () => releasePrompt,
      markPromptCompleted: vi.fn(),
      stop,
    });
    const send = vi.spyOn(deps.opencode, "send").mockRejectedValue(new Error("connection reset"));

    let routeDone = false;
    const route = routeMessage(deps, "111", CHAT_ID, "hi").then(() => {
      routeDone = true;
    });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(routeDone).toBe(false);
    expect(releasePrompt).toHaveBeenCalledWith(false, undefined);
    expect(sendNotice).not.toHaveBeenCalledWith(CHAT_ID, "Agent call failed — check whatsapp-router logs.");
    expect(endTyping).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "opencode call outcome ambiguous; live watcher retained",
      "connection reset",
    ]);
    expect(stop).not.toHaveBeenCalled();
    releaseDone();
    await route;
    expect(endTyping).toHaveBeenCalledWith(CHAT_ID);
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });

  });
  it("blocks exchange reuse after an ambiguous outcome", async () => {
    deps.sessions.set("111", "ses_1");
    const done = new Promise<void>(() => undefined);
    const makeWatch = () => ({
      isLive: true,
      awaitIdle: () => done,
      awaitChatIdle: () => Promise.resolve(),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });
    const watchSession = vi
      .spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(makeWatch())
      .mockResolvedValueOnce(makeWatch());
    vi.spyOn(deps.opencode, "send").mockRejectedValue(new Error("connection reset"));

    await routeMessage(deps, "111", CHAT_ID, "hi");
    const replacement = await deps.exchanges.acquire(deps, "111", "ses_1", "chat2");

    expect(watchSession).toHaveBeenCalledTimes(2);
    expect(replacement.created).toBe(true);
    replacement.exchange.stop();
  });
  it("defers ambiguous failure after a live session replacement", async () => {
    deps.sessions.set("111", "ses_1");
    const makeWatch = (isLive: boolean) => ({
      isLive,
      awaitIdle: () => Promise.resolve(),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });
    vi.spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(makeWatch(true))
      .mockResolvedValueOnce(makeWatch(true));
    vi.spyOn(deps.opencode, "send").mockImplementation(async (_sessionId, _text, options) => {
      await options?.onSessionReplaced?.("ses_new");
      throw new Error("connection reset after replacement");
    });
    const sendNotice = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(sendNotice).not.toHaveBeenCalledWith(CHAT_ID, "Agent call failed — check whatsapp-router logs.");
  });

  it("shows failure after replacement when the replacement watcher is not live", async () => {
    deps.sessions.set("111", "ses_1");
    const makeWatch = (isLive: boolean) => ({
      isLive,
      awaitIdle: () => Promise.resolve(),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });
    vi.spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(makeWatch(true))
      .mockResolvedValueOnce(makeWatch(false));
    vi.spyOn(deps.opencode, "send").mockImplementation(async (_sessionId, _text, options) => {
      await options?.onSessionReplaced?.("ses_new");
      throw new Error("connection reset after replacement");
    });
    const sendNotice = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(sendNotice).toHaveBeenCalledWith(CHAT_ID, "Agent call failed — check whatsapp-router logs.");
  });
  it("stops a replacement watcher after a definitive retry rejection", async () => {
    deps.sessions.set("111", "ses_1");
    const firstStop = vi.fn();
    const replacementStop = vi.fn();
    const makeWatch = (isLive: boolean, stop: () => void) => ({
      isLive,
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop,
    });
    vi.spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(makeWatch(true, firstStop))
      .mockResolvedValueOnce(makeWatch(true, replacementStop));
    vi.spyOn(deps.opencode, "send").mockImplementation(async (_sessionId, _text, options) => {
      await options?.onSessionReplaced?.("ses_new");
      throw new OpencodeSendError(500);
    });
    const sendNotice = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(replacementStop).toHaveBeenCalledTimes(1);
    expect(sendNotice).toHaveBeenCalledWith(CHAT_ID, "Agent call failed — check whatsapp-router logs.");
  });

  it("stops an exchange blocked by an ambiguous prompt before replacement", async () => {
    const makeWatch = () => ({
      isLive: true,
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    });
    const firstWatch = makeWatch();
    const secondWatch = makeWatch();
    const watchSession = vi
      .spyOn(deps.opencode, "watchSession")
      .mockResolvedValueOnce(firstWatch)
      .mockResolvedValueOnce(secondWatch);
    const manager = new AgentExchangeManager();
    const first = await manager.acquire(deps, "111", "ses_1", "chat1");
    first.exchange.reusable = false;

    const second = await manager.acquire(deps, "111", "ses_1", "chat2");

    expect(watchSession).toHaveBeenCalledTimes(2);
    expect(second.exchange).not.toBe(first.exchange);
    expect(firstWatch.stop).toHaveBeenCalledTimes(1);
    first.exchange.stop();
    second.exchange.stop();
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
  it("retries an initial delivery failure before finalizing deduplication", async () => {
    const send = vi
      .spyOn(deps.typing, "send")
      .mockRejectedValueOnce(new Error("temporary WAHA failure"))
      .mockResolvedValue(undefined);
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", CHAT_ID);

    acquired.exchange.deliver("msg_3", "reply", CHAT_ID);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send).toHaveBeenNthCalledWith(1, CHAT_ID, "reply", "msg_3", expect.any(AbortSignal));
    expect(send).toHaveBeenNthCalledWith(2, CHAT_ID, "reply", "msg_3", expect.any(AbortSignal));
    manager.stop("111", acquired.exchange);
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
      expect(deps.deliveryRetries.list("111")).toEqual([]);
    });
    acquired.exchange.deliver("msg_1", "reply", CHAT_ID);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    acquired.release();
    manager.stop("111", acquired.exchange);
  });
  it("finalizes delivery deduplication only after a successful send", async () => {
    const send = vi.spyOn(deps.typing, "send").mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    const watch = {
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => undefined,
      markPromptCompleted: vi.fn(),
      stop: vi.fn(),
    };
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue(watch);
    const manager = new AgentExchangeManager();
    const acquired = await manager.acquire(deps, "111", "ses_1", CHAT_ID);

    acquired.exchange.deliver("msg_2", "reply", CHAT_ID);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    acquired.exchange.deliver("msg_2", "reply", CHAT_ID);
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.map((call: unknown[]) => call.slice(1))).toContainEqual([
      "agent turn delivered",
      "msg_2",
      CHAT_ID,
    ]);
    setLogLevel(previousLevel);
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
    const stop = vi.fn();
    vi.spyOn(deps.opencode, "watchSession").mockResolvedValue({
      awaitIdle: () => new Promise<void>(() => undefined),
      acquirePrompt: () => releasePrompt,
      markPromptCompleted: vi.fn(),
      stop,
    });
    vi.spyOn(deps.opencode, "send").mockRejectedValue(new OpencodeSendError(500));

    await routeMessage(deps, "111", CHAT_ID, "hi");

    expect(releasePrompt).toHaveBeenCalledWith(true);
    expect(stop).toHaveBeenCalledTimes(1);
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
