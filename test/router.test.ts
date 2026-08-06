import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FireflyClient } from "../src/integrations/firefly.js";
import { HaClient } from "../src/integrations/homeAssistant.js";
import { OpencodeClient, type OpencodeMediaAttachment } from "../src/integrations/opencode.js";
import { routeMessage, type RouterDeps } from "../src/router.js";
import { SenderLock } from "../src/senderLock.js";
import { SessionStore } from "../src/sessionStore.js";
import { requestUrl } from "./testUtils.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let dir: string;
let deps: RouterDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-router-test-"));
  deps = {
    ha: new HaClient("http://ha.test", "token", "hook123"),
    firefly: new FireflyClient("http://firefly.test", "token", "Checking"),
    opencode: new OpencodeClient({ baseUrl: "http://opencode.test", authHeader: "Basic abc", modelProvider: "", modelId: "" }),
    sessions: new SessionStore(join(dir, "sessions.json")),
    senderLock: new SenderLock(),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("routeMessage — /new", () => {
  it("resets the session and returns a confirmation when sent alone", async () => {
    deps.sessions.set("111", "ses_old");
    const reply = await routeMessage(deps, "111", "/new");
    expect(reply).toEqual({ kind: "text", text: "Started a new conversation." });
    expect(deps.sessions.get("111")).toBeUndefined();
  });

  it("resets the session and forwards remaining text to the agent", async () => {
    deps.sessions.set("111", "ses_old");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "hi again" }] }));
      }),
    );

    const reply = await agentText(deps, "111", "/new hello");
    expect(reply).toBe("hi again");
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
});

describe("routeMessage — ha: prefix", () => {
  it("delegates to the HA client with the prefix stripped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const reply = await routeMessage(deps, "111", "ha: turn on lights");
    expect(reply).toEqual({ kind: "reaction", emoji: "✅" });
  });

  it("reacts with ❌ and includes the failure text when the webhook call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const reply = await routeMessage(deps, "111", "ha: turn on lights");
    expect(reply).toEqual({ kind: "reaction", emoji: "❌", text: "HA webhook failed (500)." });
  });
});

describe("routeMessage — money: prefix", () => {
  it("delegates to the Firefly client with the prefix stripped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.includes("/accounts")) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }),
          );
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );
    const reply = await routeMessage(deps, "111", "money: 20 groceries");
    expect(reply).toEqual({ kind: "reaction", emoji: "✅" });
  });

  it("reacts with ❌ and includes the failure text when the format is invalid", async () => {
    const reply = await routeMessage(deps, "111", "money: groceries");
    expect(reply).toEqual({
      kind: "reaction",
      emoji: "❌",
      text: 'Format: "money: <amount> <description>", e.g. "money: 20 groceries"',
    });
  });
});

async function agentText(
  deps: RouterDeps,
  senderKey: string,
  text: string,
  media?: OpencodeMediaAttachment,
): Promise<string> {
  const reply = await routeMessage(deps, senderKey, text, media ? { media: [media] } : {});
  if (reply.kind !== "text") throw new Error(`expected a text reply, got ${reply.kind}`);
  return reply.text;
}

describe("routeMessage — default (agent)", () => {
  it("creates a session on first contact and sends the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "hello!" }] }));
      }),
    );

    const reply = await agentText(deps, "111", "hi there");
    expect(reply).toBe("hello!");
    expect(deps.sessions.get("111")).toBe("ses_1");
  });

  it("converts the agent's Markdown reply to WhatsApp formatting before returning it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] }));
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
      vi.fn().mockResolvedValue(jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] })),
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
        return Promise.resolve(jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] }));
      }),
    );

    const reply = await agentText(deps, "111", "hi");

    expect(deps.sessions.get("111")).toBe("ses_new");
    expect(reply).not.toBe("Agent call failed — check whatsapp-router logs.");
  });

  it("returns a failure message and logs when the opencode call throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const reply = await agentText(deps, "111", "hi");
    expect(reply).toBe("Agent call failed — check whatsapp-router logs.");
  });

  it("is case-insensitive and trims surrounding whitespace for every prefix", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const reply = await routeMessage(deps, "111", "  HA:  turn on lights  ");
    expect(reply).toEqual({ kind: "reaction", emoji: "✅" });
  });

  it("treats a bare '/new' prefix (e.g. '/newfoo') as agent text, not the reset command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
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
    const reply = await routeMessage(deps, "111", "/new", { media: [] });
    expect(reply).toEqual({ kind: "text", text: "Started a new conversation." });
  });

  it("forwards to the agent (instead of the plain reset confirmation) when media is attached without trailing text", async () => {
    const media: OpencodeMediaAttachment = { mimetype: "image/jpeg", dataBase64: "Zm9v" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
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
        capturedBody = JSON.parse(await (input as Request).clone().text()) as unknown;
        return jsonResponse({ info: {}, parts: [{ type: "text", text: finalReply }] });
      }),
    );
    return { body: () => capturedBody };
  }

  it("formats a 1:1-chat system context with the sender's name and phone", async () => {
    const capture = captureSystem();
    const reply = await routeMessage(deps, "111", "hi", {
      context: {
        senderName: "Marcos Vinícius Rubido",
        senderPhone: "111",
        isGroupChat: false,
      },
    });

    if (reply.kind !== "text") throw new Error("expected a text reply");
    expect(reply.text).toBe("ok");
    expect(capture.body()).toMatchObject({
      system:
        "You are being reached over WhatsApp.\n" +
        "Message from: Marcos Vinícius Rubido (+111)\n" +
        "Chat: a direct message (not a group)",
    });
  });

  it("formats a group-chat system context with the group's name", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", "hi", {
      context: {
        senderName: "Marcos",
        senderPhone: "111",
        isGroupChat: true,
        groupName: "Jarvis Test",
      },
    });

    expect(capture.body()).toMatchObject({
      system:
        "You are being reached over WhatsApp.\n" +
        "Message from: Marcos (+111)\n" +
        'Chat: a group named "Jarvis Test"',
    });
  });

  it("falls back to just the phone number when the sender's push name is unavailable", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", "hi", {
      context: { senderPhone: "111", isGroupChat: false },
    });

    expect(capture.body()).toMatchObject({
      system: expect.stringContaining("Message from: +111\n") as string,
    });
  });

  it("says just 'a group' when the group has no known name", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", "hi", {
      context: { senderPhone: "111", isGroupChat: true },
    });

    const body = capture.body() as { system: string };
    expect(body.system.split("\n")).toContain("Chat: a group");
  });

  it("includes the send timestamp as an ISO string when provided", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", "hi", {
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
    await routeMessage(deps, "111", "hi", {
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
    await routeMessage(deps, "111", "hi");

    const body = capture.body() as { system?: unknown };
    expect(body.system).toBeUndefined();
  });

  it("includes a shared location when present", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", "hi", {
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
    await routeMessage(deps, "111", "hi", {
      context: {
        senderPhone: "111",
        isGroupChat: true,
        recentMessages: "Marcos: How much is it?\nSisyphus: It's 4.",
      },
    });

    const system = (capture.body() as { system: string }).system;
    expect(system).toContain("Recent messages in this group");
    expect(system).toContain("Marcos: How much is it?\nSisyphus: It's 4.");
  });

  it("omits the recent-history line when not present", async () => {
    const capture = captureSystem();
    await routeMessage(deps, "111", "hi", {
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
        return Promise.resolve(
          jsonResponse({ info: {}, parts: [{ type: "text", text: "got your location" }] }),
        );
      }),
    );
    deps.sessions.set("111", "ses_old");

    const reply = await routeMessage(deps, "111", "/new", {
      context: { senderPhone: "111", isGroupChat: false, locationText: "1.5, 2.5" },
    });

    if (reply.kind !== "text") throw new Error("expected a text reply");
    expect(reply.text).toBe("got your location");
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
});
