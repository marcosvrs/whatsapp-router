import { afterEach, describe, expect, it, vi } from "vitest";
import { Identity } from "../../src/waha/identity.js";
import type { WahaClientLike, WahaGroup, WahaSessionInfo } from "../../src/waha/client.js";

function fakeWaha(overrides: Partial<WahaClientLike> = {}): WahaClientLike {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
    markChatRead: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    fetchGroups: vi.fn().mockResolvedValue({}),
    fetchSessionInfo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Identity.ensureLidMap / resolvePhone", () => {
  it("resolves a phone-form jid without needing the lid map", () => {
    const identity = new Identity(fakeWaha());
    expect(identity.resolvePhone("111@c.us")).toBe("111");
  });

  it("returns undefined for a @lid jid before the map has loaded", () => {
    const identity = new Identity(fakeWaha());
    expect(identity.resolvePhone("999@lid")).toBeUndefined();
  });

  it("resolves a @lid jid to its phone number after loading group participants", async () => {
    const groups: Record<string, WahaGroup> = {
      g1: { participants: [{ id: "999@lid", phoneNumber: "111@c.us" }] },
    };
    const identity = new Identity(fakeWaha({ fetchGroups: vi.fn().mockResolvedValue(groups) }));
    await identity.ensureLidMap();
    expect(identity.resolvePhone("999@lid")).toBe("111");
  });

  it("skips participants missing an id or phoneNumber", async () => {
    const groups: Record<string, WahaGroup> = {
      g1: { participants: [{ id: "999@lid" }, { phoneNumber: "111@c.us" }] },
    };
    const identity = new Identity(fakeWaha({ fetchGroups: vi.fn().mockResolvedValue(groups) }));
    await identity.ensureLidMap();
    expect(identity.resolvePhone("999@lid")).toBeUndefined();
  });

  it("does not throw when fetchGroups rejects", async () => {
    const identity = new Identity(
      fakeWaha({ fetchGroups: vi.fn().mockRejectedValue(new Error("network down")) }),
    );
    await expect(identity.ensureLidMap()).resolves.toBeUndefined();
  });

  it("does not re-fetch groups within the ttl", async () => {
    const fetchGroups = vi.fn().mockResolvedValue({});
    const identity = new Identity(fakeWaha({ fetchGroups }));
    await identity.ensureLidMap();
    await identity.ensureLidMap();
    expect(fetchGroups).toHaveBeenCalledTimes(1);
  });

  it("re-fetches groups once the ttl has elapsed", async () => {
    vi.useFakeTimers();
    const fetchGroups = vi.fn().mockResolvedValue({});
    const identity = new Identity(fakeWaha({ fetchGroups }));
    await identity.ensureLidMap();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await identity.ensureLidMap();
    expect(fetchGroups).toHaveBeenCalledTimes(2);
  });

  it("logs the exact refreshed message with the resolved entry count", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const groups: Record<string, WahaGroup> = {
      g1: { participants: [{ id: "999@lid", phoneNumber: "111@c.us" }] },
    };
    const identity = new Identity(fakeWaha({ fetchGroups: vi.fn().mockResolvedValue(groups) }));
    await identity.ensureLidMap();

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["lid map refreshed", 1, "entries"]);
  });

  it("logs the exact failure message when fetchGroups rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const identity = new Identity(
      fakeWaha({ fetchGroups: vi.fn().mockRejectedValue(new Error("network down")) }),
    );
    await identity.ensureLidMap();

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["lid map refresh failed", "network down"]);
  });
});

describe("Identity.ensureBotIds / isBotId", () => {
  it("loads both the phone and lid forms of the bot's own id", async () => {
    const info: WahaSessionInfo = { me: { id: "555@c.us", lid: "777@lid" } };
    const identity = new Identity(fakeWaha({ fetchSessionInfo: vi.fn().mockResolvedValue(info) }));
    await identity.ensureBotIds();
    expect(identity.isBotId("555")).toBe(true);
    expect(identity.isBotId("777")).toBe(true);
    expect(identity.isBotId("999")).toBe(false);
  });

  it("only fetches session info once, even across multiple calls", async () => {
    const fetchSessionInfo = vi.fn().mockResolvedValue({ me: { id: "555@c.us" } });
    const identity = new Identity(fakeWaha({ fetchSessionInfo }));
    await identity.ensureBotIds();
    await identity.ensureBotIds();
    expect(fetchSessionInfo).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fetchSessionInfo rejects", async () => {
    const identity = new Identity(
      fakeWaha({ fetchSessionInfo: vi.fn().mockRejectedValue(new Error("network down")) }),
    );
    await expect(identity.ensureBotIds()).resolves.toBeUndefined();
    expect(identity.isBotId("anything")).toBe(false);
  });

  it("treats a null session info response as not-yet-loaded", async () => {
    const identity = new Identity(fakeWaha({ fetchSessionInfo: vi.fn().mockResolvedValue(null) }));
    await identity.ensureBotIds();
    expect(identity.isBotId("anything")).toBe(false);
  });

  it("retries fetchSessionInfo on a later call after a null response", async () => {
    const fetchSessionInfo = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ me: { id: "555@c.us" } });
    const identity = new Identity(fakeWaha({ fetchSessionInfo }));
    await identity.ensureBotIds();
    await identity.ensureBotIds();
    expect(fetchSessionInfo).toHaveBeenCalledTimes(2);
    expect(identity.isBotId("555")).toBe(true);
  });

  it("loads only the id when lid is absent", async () => {
    const identity = new Identity(
      fakeWaha({ fetchSessionInfo: vi.fn().mockResolvedValue({ me: { id: "555@c.us" } }) }),
    );
    await identity.ensureBotIds();
    expect(identity.isBotId("555")).toBe(true);
  });

  it("logs the exact loaded message with the joined id list", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info: WahaSessionInfo = { me: { id: "555@c.us", lid: "777@lid" } };
    const identity = new Identity(fakeWaha({ fetchSessionInfo: vi.fn().mockResolvedValue(info) }));
    await identity.ensureBotIds();

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["bot ids loaded", "555,777"]);
  });

  it("logs the exact failure message when fetchSessionInfo rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const identity = new Identity(
      fakeWaha({ fetchSessionInfo: vi.fn().mockRejectedValue(new Error("network down")) }),
    );
    await identity.ensureBotIds();

    const logged = logSpy.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(logged).toContainEqual(["bot ids load failed", "network down"]);
  });
});
