import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FireflyClient } from "../src/integrations/firefly.js";
import { HaClient } from "../src/integrations/homeAssistant.js";
import { OpencodeClient } from "../src/integrations/opencode.js";
import { routeMessage, type RouterDeps } from "../src/router.js";
import { SenderLock } from "../src/senderLock.js";
import { SessionStore } from "../src/sessionStore.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let dir: string;
let deps: RouterDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-router-test-"));
  deps = {
    ha: new HaClient("http://ha.test", "token", "hook123"),
    firefly: new FireflyClient("http://firefly.test", "token", "Checking"),
    opencode: new OpencodeClient("http://opencode.test", "Basic abc", "", "", true),
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
    expect(reply).toBe("Started a new conversation.");
    expect(deps.sessions.get("111")).toBeUndefined();
  });

  it("resets the session and forwards remaining text to the agent", async () => {
    deps.sessions.set("111", "ses_old");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        return Promise.resolve(jsonResponse({ parts: [{ type: "text", text: "hi again" }] }));
      }),
    );

    const reply = await routeMessage(deps, "111", "/new hello");
    expect(reply).toBe("hi again");
    expect(deps.sessions.get("111")).toBe("ses_new");
  });
});

describe("routeMessage — ha: prefix", () => {
  it("delegates to the HA client with the prefix stripped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const reply = await routeMessage(deps, "111", "ha: turn on lights");
    expect(reply).toBe("Sent to Home Assistant.");
  });
});

describe("routeMessage — money: prefix", () => {
  it("delegates to the Firefly client with the prefix stripped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/accounts")) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "42", attributes: { name: "Checking" } }] }),
          );
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );
    const reply = await routeMessage(deps, "111", "money: 20 groceries");
    expect(reply).toBe("Logged: 20 — groceries");
  });
});

describe("routeMessage — default (agent)", () => {
  it("creates a session on first contact and sends the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        return Promise.resolve(jsonResponse({ parts: [{ type: "text", text: "hello!" }] }));
      }),
    );

    const reply = await routeMessage(deps, "111", "hi there");
    expect(reply).toBe("hello!");
    expect(deps.sessions.get("111")).toBe("ses_1");
  });

  it("reuses an existing session instead of creating a new one", async () => {
    deps.sessions.set("111", "ses_existing");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ parts: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await routeMessage(deps, "111", "hi again");

    const sessionCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].endsWith("/session"),
    );
    expect(sessionCalls).toHaveLength(0);
  });

  it("returns a friendly message when opencode isn't configured", async () => {
    deps.opencode = new OpencodeClient("http://opencode.test", "", "", "", true);
    const reply = await routeMessage(deps, "111", "hi");
    expect(reply).toBe("opencode agent not configured yet.");
  });

  it("touches (not replaces) the stored session id when it didn't change", async () => {
    deps.sessions.set("111", "ses_existing");
    const touchSpy = vi.spyOn(deps.sessions, "touch");
    const setSpy = vi.spyOn(deps.sessions, "set");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ parts: [{ type: "text", text: "ok" }] })),
    );

    await routeMessage(deps, "111", "hi again");

    expect(touchSpy).toHaveBeenCalledWith("111");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("replaces the stored session id when opencode recovers from a stale one", async () => {
    deps.sessions.set("111", "ses_stale");
    const touchSpy = vi.spyOn(deps.sessions, "touch");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_new" }));
        return Promise.resolve(jsonResponse({ status: 404 }, 404));
      }),
    );

    const reply = await routeMessage(deps, "111", "hi");

    expect(deps.sessions.get("111")).toBe("ses_new");
    expect(touchSpy).not.toHaveBeenCalled();
    expect(reply).not.toBe("Agent call failed — check whatsapp-router logs.");
  });

  it("returns a failure message and logs when the opencode call throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const reply = await routeMessage(deps, "111", "hi");
    expect(reply).toBe("Agent call failed — check whatsapp-router logs.");
  });

  it("is case-insensitive and trims surrounding whitespace for every prefix", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const reply = await routeMessage(deps, "111", "  HA:  turn on lights  ");
    expect(reply).toBe("Sent to Home Assistant.");
  });

  it("treats a bare '/new' prefix (e.g. '/newfoo') as agent text, not the reset command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse({ id: "ses_1" }));
        return Promise.resolve(jsonResponse({ parts: [{ type: "text", text: "handled" }] }));
      }),
    );
    deps.sessions.set("111", "ses_untouched");
    const reply = await routeMessage(deps, "111", "/newfoo bar");
    expect(reply).toBe("handled");
    // "/new" only matches at a word boundary — session must NOT have been reset.
    expect(deps.sessions.get("111")).not.toBeUndefined();
  });
});
