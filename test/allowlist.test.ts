import { describe, expect, it, vi } from "vitest";
import { resolveAllowedSender } from "../src/allowlist.js";
import type { IdentityResolver } from "../src/waha/identity.js";
import type { WahaMessage } from "../src/waha/payload.js";

function fakeIdentity(overrides: Partial<IdentityResolver> = {}): IdentityResolver {
  return {
    ensureLidMap: vi.fn().mockResolvedValue(undefined),
    ensureBotIds: vi.fn().mockResolvedValue(undefined),
    resolvePhone: (jid) => jid?.split("@")[0],
    isBotId: () => false,
    ...overrides,
  };
}

describe("resolveAllowedSender — 1:1 chats", () => {
  it("allows a sender on the allowlist", async () => {
    const identity = fakeIdentity();
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "111@c.us",
      {},
    );
    expect(result).toBe("111");
  });

  it("rejects a sender not on the allowlist", async () => {
    const identity = fakeIdentity();
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "999@c.us",
      {},
    );
    expect(result).toBeNull();
  });

  it("resolves an @lid sender via identity.resolvePhone before checking the allowlist", async () => {
    const identity = fakeIdentity({ resolvePhone: () => "111" });
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "999999@lid",
      {},
    );
    expect(result).toBe("111");
  });

  it("rejects when the lid can't be resolved to a phone", async () => {
    const identity = fakeIdentity({ resolvePhone: () => undefined });
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "999999@lid",
      {},
    );
    expect(result).toBeNull();
  });
});

describe("resolveAllowedSender — group chats", () => {
  const mentionMsg: WahaMessage = {
    participant: "111@c.us",
    _data: { message: { extendedTextMessage: { contextInfo: { mentionedJid: ["botid@lid"] } } } },
  };

  it("rejects a group message that doesn't mention the bot", async () => {
    const identity = fakeIdentity({ isBotId: () => false });
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "group@g.us",
      mentionMsg,
    );
    expect(result).toBeNull();
  });

  it("allows a mentioned + allowlisted participant", async () => {
    const identity = fakeIdentity({ isBotId: (id) => id === "botid" });
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "group@g.us",
      mentionMsg,
    );
    expect(result).toBe("111");
  });

  it("rejects a mentioned but non-allowlisted participant", async () => {
    const identity = fakeIdentity({ isBotId: (id) => id === "botid" });
    const result = await resolveAllowedSender(
      identity,
      new Set(["999"]),
      "group@g.us",
      mentionMsg,
    );
    expect(result).toBeNull();
  });

  it("does not require the group itself to be on any allowlist", async () => {
    // No group allowlist exists by design — any group works as long as the
    // mentioning participant is allowlisted.
    const identity = fakeIdentity({ isBotId: (id) => id === "botid" });
    const result = await resolveAllowedSender(
      identity,
      new Set(["111"]),
      "some-other-group@g.us",
      mentionMsg,
    );
    expect(result).toBe("111");
  });
});
