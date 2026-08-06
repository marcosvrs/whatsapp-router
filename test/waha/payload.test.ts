import { describe, expect, it } from "vitest";
import {
  extractMentionedIds,
  messageDedupeKey,
  stripMentions,
  type WahaMessage,
} from "../../src/waha/payload.js";

function plainMessage(overrides: Partial<WahaMessage> = {}): WahaMessage {
  return { id: "msg1", from: "111@c.us", body: "hello", timestamp: 123, ...overrides };
}

function mentionMessage(mentionedJid: string[], body: string): WahaMessage {
  return {
    id: "msg2",
    from: "group@g.us",
    body,
    _data: { message: { extendedTextMessage: { contextInfo: { mentionedJid } } } },
  };
}

describe("extractMentionedIds", () => {
  it("returns an empty array for a plain text message", () => {
    expect(extractMentionedIds(plainMessage())).toEqual([]);
  });

  it("extracts the phone/lid part of each mentioned jid", () => {
    const msg = mentionMessage(["999888777666555@lid", "111@c.us"], "@999888777666555 hi");
    expect(extractMentionedIds(msg)).toEqual(["999888777666555", "111"]);
  });

  it("returns an empty array when contextInfo has no mentionedJid", () => {
    const msg: WahaMessage = {
      _data: { message: { extendedTextMessage: { contextInfo: {} } } },
    };
    expect(extractMentionedIds(msg)).toEqual([]);
  });
});

describe("stripMentions", () => {
  it("removes every mentioned id's @-markup from the text", () => {
    const msg = mentionMessage(["999888777666555@lid"], "@999888777666555 hello there");
    expect(stripMentions("@999888777666555 hello there", msg)).toBe("hello there");
  });

  it("removes markup for multiple mentioned ids", () => {
    const msg = mentionMessage(["1@lid", "2@lid"], "@1 @2 check this out");
    expect(stripMentions("@1 @2 check this out", msg)).toBe("check this out");
  });

  it("returns the text unchanged when there are no mentions", () => {
    const msg = plainMessage();
    expect(stripMentions("hello", msg)).toBe("hello");
  });
});

describe("messageDedupeKey", () => {
  it("uses the message id when present", () => {
    expect(messageDedupeKey(plainMessage({ id: "abc" }))).toBe("abc");
  });

  it("falls back to from|body|timestamp when id is missing", () => {
    const key = messageDedupeKey({ from: "111@c.us", body: "hi", timestamp: 42 });
    expect(key).toBe("111@c.us|hi|42");
  });
});
