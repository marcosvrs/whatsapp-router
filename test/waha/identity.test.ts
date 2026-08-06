import { describe, expect, it, vi } from "vitest";
import { Identity } from "../../src/waha/identity.js";
import type { WahaClientLike, WahaGroup, WahaSessionInfo } from "../../src/waha/client.js";

function fakeWaha(overrides: Partial<WahaClientLike> = {}): WahaClientLike {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    fetchGroups: vi.fn().mockResolvedValue({}),
    fetchSessionInfo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

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
});
