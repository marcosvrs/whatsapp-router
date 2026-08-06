import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { MessageDedupe } from "../src/dedupe.js";
import { FireflyClient } from "../src/integrations/firefly.js";
import { HaClient } from "../src/integrations/homeAssistant.js";
import { OpencodeClient } from "../src/integrations/opencode.js";
import { RateLimiter } from "../src/rateLimit.js";
import { SenderLock } from "../src/senderLock.js";
import { SessionStore } from "../src/sessionStore.js";
import { buildServer, type ServerDeps } from "../src/server.js";
import type { IdentityResolver } from "../src/waha/identity.js";
import type { WahaClientLike } from "../src/waha/client.js";
import { requestUrl } from "./testUtils.js";

const SECRET = "test-secret";

function testConfig(): Config {
  return {
    port: 0,
    allowedUsers: new Set(["111"]),
    wahaBaseUrl: "http://waha.test",
    wahaApiKey: "key",
    wahaSession: "test",
    webhookSecret: SECRET,
    hassBaseUrl: "http://ha.test",
    hassToken: "",
    haWebhookId: "",
    fireflyBaseUrl: "http://firefly.test",
    fireflyPat: "",
    fireflyDefaultSourceAccount: "",
    opencodeBaseUrl: "http://opencode.test",
    opencodeAuthHeader: "",
    opencodeModelProvider: "",
    opencodeModelId: "",
    sessionsFile: "",
    maxBodyBytes: 64 * 1024,
    rateLimitMax: 20,
    rateLimitWindowMs: 5 * 60 * 1000,
  };
}

function sign(body: string): string {
  return createHmac("sha512", SECRET).update(body).digest("hex");
}

let dir: string;
let config: Config;
let deps: ServerDeps;
let sentMessages: { chatId: string; text: string }[];
let identity: IdentityResolver;
let server: ReturnType<typeof buildServer>;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-server-test-"));
  config = { ...testConfig(), sessionsFile: join(dir, "sessions.json") };

  sentMessages = [];
  const waha: WahaClientLike = {
    sendText: vi.fn().mockImplementation((chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return Promise.resolve();
    }),
    startTyping: vi.fn().mockResolvedValue(undefined),
    markChatRead: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    fetchGroups: vi.fn().mockResolvedValue({}),
    fetchSessionInfo: vi.fn().mockResolvedValue(null),
    downloadMedia: vi.fn().mockResolvedValue(null),
  };

  identity = {
    ensureLidMap: vi.fn().mockResolvedValue(undefined),
    ensureBotIds: vi.fn().mockResolvedValue(undefined),
    resolvePhone: (jid) => jid?.split("@")[0],
    isBotId: () => false,
  };

  deps = {
    waha,
    identity,
    rateLimiter: new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs),
    dedupe: new MessageDedupe(5 * 60 * 1000),
    router: {
      ha: new HaClient(config.hassBaseUrl, config.hassToken, config.haWebhookId),
      firefly: new FireflyClient(
        config.fireflyBaseUrl,
        config.fireflyPat,
        config.fireflyDefaultSourceAccount,
      ),
      opencode: new OpencodeClient({ baseUrl: config.opencodeBaseUrl, authHeader: "Basic abc", modelProvider: "", modelId: "" }),
      sessions: new SessionStore(config.sessionsFile),
      senderLock: new SenderLock(),
    },
  };

  server = buildServer(config, deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// Uses node:http directly rather than global fetch — tests stub global fetch
// to control the router's own outbound calls (to opencode/firefly/etc.), and
// that stub must not also intercept this test's request to our own server.
function rawRequest(
  path: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      { method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0 });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function postWebhook(body: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return rawRequest("/webhook", "POST", body, headers);
}

describe("server routing", () => {
  it("returns 404 for a GET request", async () => {
    const res = await rawRequest("/webhook", "GET", "");
    expect(res.status).toBe(404);
  });

  it("returns 404 for the wrong path", async () => {
    const res = await postWebhook("{}", { "X-Webhook-Hmac": sign("{}") });
    const wrongPath = await rawRequest("/nope", "POST", "{}");
    expect(wrongPath.status).toBe(404);
    expect(res.status).toBe(200); // sanity: /webhook itself is fine
  });
});

describe("server webhook auth", () => {
  it("rejects a request with no signature", async () => {
    const res = await postWebhook("{}");
    expect(res.status).toBe(401);
  });

  it("rejects a request with a wrong signature", async () => {
    const res = await postWebhook("{}", { "X-Webhook-Hmac": "wrong" });
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed request", async () => {
    const body = "{}";
    const res = await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(res.status).toBe(200);
  });

  it("rejects a body over the size limit before checking the signature", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(config.maxBodyBytes + 1) });
    const res = await postWebhook(oversized, { "X-Webhook-Hmac": sign(oversized) });
    expect(res.status).toBe(413);
  });
});

function messageBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "message",
    payload: { id: "m1", from: "111@c.us", body: "hello", ...overrides },
  });
}

describe("server message handling", () => {
  it("ignores non-message events", async () => {
    const body = JSON.stringify({ event: "state.change" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(sentMessages).toHaveLength(0);
  });

  it("ignores messages sent by the bot itself", async () => {
    const body = messageBody({ fromMe: true });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(sentMessages).toHaveLength(0);
  });

  it("ignores messages from a sender not on the allowlist", async () => {
    const body = messageBody({ from: "999@c.us" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(sentMessages).toHaveLength(0);
  });

  it("routes an allowlisted 1:1 message and replies via waha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "ses_1" }), { headers: { "Content-Type": "application/json" } }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );

    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(sentMessages).toEqual([{ chatId: "111@c.us", text: "…" }]);
    expect(deps.waha.editMessage).toHaveBeenCalledWith(
      "111@c.us",
      expect.any(String),
      "hi!",
    );
  });

  it("de-dupes a repeated delivery of the same message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "ses_1" }), { headers: { "Content-Type": "application/json" } }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );

    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(sentMessages).toHaveLength(1);
  });

  it("rejects a group message when the bot isn't mentioned", async () => {
    identity.isBotId = () => false;
    const body = messageBody({ from: "group@g.us", participant: "111@c.us" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(sentMessages).toHaveLength(0);
  });

  it("routes a group message that mentions the bot from an allowlisted participant", async () => {
    identity.isBotId = (id) => id === "botid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "ses_1" }), { headers: { "Content-Type": "application/json" } }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );

    const body = messageBody({
      from: "group@g.us",
      participant: "111@c.us",
      body: "@botid hello",
      _data: {
        message: { extendedTextMessage: { contextInfo: { mentionedJid: ["botid@lid"] } } },
      },
    });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(sentMessages).toEqual([{ chatId: "group@g.us", text: "…" }]);
    expect(deps.waha.editMessage).toHaveBeenCalledWith(
      "group@g.us",
      expect.any(String),
      "hi!",
    );
  });

  it("replies with a rate-limit message once the sender's limit is exceeded", async () => {
    deps.rateLimiter = new RateLimiter(1, 5 * 60 * 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "ses_1" }), { headers: { "Content-Type": "application/json" } }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );

    const first = messageBody({ id: "m1" });
    const second = messageBody({ id: "m2" });
    await postWebhook(first, { "X-Webhook-Hmac": sign(first) });
    await postWebhook(second, { "X-Webhook-Hmac": sign(second) });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]?.text).toBe("Rate limit reached — try again in a few minutes.");
  });

  it("ignores a message with an empty body", async () => {
    const body = messageBody({ body: "" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(sentMessages).toHaveLength(0);
  });

  it("marks the chat as read once the sender is allowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "ses_1" }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.markChatRead).toHaveBeenCalledWith("111@c.us");
  });

  it("does not mark the chat as read when the sender isn't allowed", async () => {
    const body = messageBody({ from: "999@c.us" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(deps.waha.markChatRead).not.toHaveBeenCalled();
  });

  it("still marks the chat as read when the sender is rate limited", async () => {
    deps.rateLimiter = new RateLimiter(0, 5 * 60 * 1000);
    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(deps.waha.markChatRead).toHaveBeenCalledWith("111@c.us");
  });

  it("sends a typing indicator before routing to the agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "ses_1" }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.startTyping).toHaveBeenCalledWith("111@c.us");
  });

  it("does not send a typing indicator when the sender is rate limited", async () => {
    deps.rateLimiter = new RateLimiter(0, 5 * 60 * 1000);
    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });
    expect(deps.waha.startTyping).not.toHaveBeenCalled();
  });

  it("sends a plain text reply for a bare /new command", async () => {
    const body = messageBody({ body: "/new" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(sentMessages).toEqual([{ chatId: "111@c.us", text: "Started a new conversation." }]);
    expect(deps.waha.editMessage).not.toHaveBeenCalled();
    expect(deps.waha.sendReaction).not.toHaveBeenCalled();
  });

  it("reacts with an emoji for a successful ha: command instead of sending text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    deps.router.ha = new HaClient("http://ha.test", "token", "hook123");

    const body = messageBody({ body: "ha: turn on lights" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.sendReaction).toHaveBeenCalledWith("m1", "✅");
    expect(deps.waha.sendText).not.toHaveBeenCalled();
  });

  it("reacts with ❌ and also sends the failure text when ha: isn't configured", async () => {
    const body = messageBody({ body: "ha: turn on lights" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.sendReaction).toHaveBeenCalledWith("m1", "❌");
    expect(sentMessages).toEqual([
      { chatId: "111@c.us", text: "Home Assistant webhook not configured yet." },
    ]);
  });

  it("sends a placeholder message then edits it in place with the final agent reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "ses_1" }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "final reply" }] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    const body = messageBody({ body: "hi there" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(sentMessages).toHaveLength(1);
    const sendCall = (deps.waha.sendText as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const [, , placeholderId] = sendCall;
    expect(placeholderId).toBeTruthy();
    expect(deps.waha.editMessage).toHaveBeenCalledWith("111@c.us", placeholderId, "final reply");
  });

  it("downloads and forwards an image with a caption to the agent", async () => {
    (deps.waha.downloadMedia as ReturnType<typeof vi.fn>).mockResolvedValue("Zm9v");
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return new Response(JSON.stringify({ id: "ses_1" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        capturedBody = JSON.parse(await (input as Request).clone().text()) as unknown;
        return new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "nice!" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const body = messageBody({
      body: "check this out",
      hasMedia: true,
      media: { url: "http://waha.test/api/files/m1.jpg", mimetype: "image/jpeg", filename: null },
    });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.downloadMedia).toHaveBeenCalledWith("http://waha.test/api/files/m1.jpg");
    expect(capturedBody).toMatchObject({
      parts: [
        { type: "text", text: "check this out" },
        { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,Zm9v" },
      ],
    });
  });

  it("processes a media-only message with no caption instead of dropping it", async () => {
    (deps.waha.downloadMedia as ReturnType<typeof vi.fn>).mockResolvedValue("YmFy");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "ses_1" }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "got the file" }] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    const body = messageBody({
      body: "",
      hasMedia: true,
      media: { url: "http://waha.test/api/files/m1.pdf", mimetype: "application/pdf", filename: "doc.pdf" },
    });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.downloadMedia).toHaveBeenCalledWith("http://waha.test/api/files/m1.pdf");
    expect(deps.waha.editMessage).toHaveBeenCalledWith(
      "111@c.us",
      expect.any(String),
      "got the file",
    );
  });

  it("does not attempt a download when WAHA itself failed to fetch the media", async () => {
    const body = messageBody({
      body: "",
      hasMedia: true,
      media: { url: null, mimetype: "image/jpeg", filename: null, error: "download failed" },
    });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(deps.waha.downloadMedia).not.toHaveBeenCalled();
    // No text and no usable media — nothing worth forwarding to the agent.
    expect(sentMessages).toHaveLength(0);
  });

  it("falls back to text-only when the media download itself fails", async () => {
    (deps.waha.downloadMedia as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return new Response(JSON.stringify({ id: "ses_1" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        capturedBody = JSON.parse(await (input as Request).clone().text()) as unknown;
        return new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "ok" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const body = messageBody({
      body: "check this out",
      hasMedia: true,
      media: { url: "http://waha.test/api/files/m1.jpg", mimetype: "image/jpeg", filename: null },
    });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(capturedBody).toMatchObject({ parts: [{ type: "text", text: "check this out" }] });
  });

  it("does not strip @-mention markup from a 1:1 message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "ses_1" }), { headers: { "Content-Type": "application/json" } }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );
    const sendSpy = vi.spyOn(deps.router.opencode, "send");

    const body = messageBody({ body: "@someone check this out" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(sendSpy).toHaveBeenCalledWith("ses_1", "@someone check this out", undefined);
  });

  it("does not crash and logs on malformed JSON, after already responding 200", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = "not valid json";
    const res = await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    expect(res.status).toBe(200);
    expect(sentMessages).toHaveLength(0);
    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual([
      "webhook handling error",
      expect.stringContaining("JSON"),
    ]);
  });

  it("logs the exact rejection reason for a non-allowlisted 1:1 sender", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = messageBody({ from: "999@c.us" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["rejected sender", "999@c.us"]);
  });

  it("logs the exact rejection reason for an unmentioned group message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    identity.isBotId = () => false;
    const body = messageBody({ from: "group@g.us", participant: "111@c.us" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual([
      "ignored group message (not mentioned or not allowed)",
      "group@g.us",
    ]);
  });

  it("logs the exact rate-limit message with the sender key", async () => {
    deps.rateLimiter = new RateLimiter(0, 5 * 60 * 1000);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = messageBody();
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["rate limited", "111"]);
  });

  it("logs the inbound message with the sender and a truncated preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: unknown) => {
        const url = requestUrl(input);
        if (url.endsWith("/session")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "ses_1" }), { headers: { "Content-Type": "application/json" } }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ info: {}, parts: [{ type: "text", text: "hi!" }] }), { headers: { "Content-Type": "application/json" } }),
        );
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = messageBody({ body: "hello" });
    await postWebhook(body, { "X-Webhook-Hmac": sign(body) });

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["inbound", "111@c.us", '"hello"']);
  });
});

describe("server auth/size log messages", () => {
  it("logs the exact reason a body is rejected as too large", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const oversized = JSON.stringify({ padding: "x".repeat(config.maxBodyBytes + 1) });
    await postWebhook(oversized, { "X-Webhook-Hmac": sign(oversized) });

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["rejected webhook: body too large"]);
  });

  it("logs the exact reason a signature is rejected", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await postWebhook("{}", { "X-Webhook-Hmac": "wrong" });

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["rejected webhook: bad or missing hmac signature"]);
  });
});
