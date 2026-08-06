import { describe, expect, it } from "vitest";
import {
  extractMentionedIds,
  extractPushName,
  formatLocation,
  formatRecentMessages,
  hasDownloadableMedia,
  messageDedupeKey,
  RECENT_MEDIA_MAX,
  selectRecentMedia,
  stripMentions,
  trimSinceLastMention,
  type WahaHistoryMessage,
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

function mediaCaptionMentionMessage(
  kind: "imageMessage" | "documentMessage" | "videoMessage",
  mentionedJid: string[],
): WahaMessage {
  return {
    id: "msg3",
    from: "group@g.us",
    body: "@999888777666555 check this out",
    hasMedia: true,
    _data: { message: { [kind]: { contextInfo: { mentionedJid } } } },
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

  it("returns an empty array for a completely empty message object", () => {
    expect(extractMentionedIds({})).toEqual([]);
  });

  it("extracts mentions from an image caption's contextInfo", () => {
    const msg = mediaCaptionMentionMessage("imageMessage", ["999888777666555@lid"]);
    expect(extractMentionedIds(msg)).toEqual(["999888777666555"]);
  });

  it("extracts mentions from a document caption's contextInfo", () => {
    const msg = mediaCaptionMentionMessage("documentMessage", ["111@c.us"]);
    expect(extractMentionedIds(msg)).toEqual(["111"]);
  });

  it("extracts mentions from a video caption's contextInfo", () => {
    const msg = mediaCaptionMentionMessage("videoMessage", ["222@c.us"]);
    expect(extractMentionedIds(msg)).toEqual(["222"]);
  });

  it("prefers extendedTextMessage's contextInfo when somehow multiple message types are present", () => {
    const msg: WahaMessage = {
      _data: {
        message: {
          extendedTextMessage: { contextInfo: { mentionedJid: ["1@c.us"] } },
          imageMessage: { contextInfo: { mentionedJid: ["2@c.us"] } },
        },
      },
    };
    expect(extractMentionedIds(msg)).toEqual(["1"]);
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

  it("falls back with empty-string segments when from/body/timestamp are all missing", () => {
    expect(messageDedupeKey({})).toBe("||");
  });

  it("produces different keys for different timestamps of an otherwise-identical message", () => {
    const key1 = messageDedupeKey({ from: "111@c.us", body: "hi", timestamp: 1 });
    const key2 = messageDedupeKey({ from: "111@c.us", body: "hi", timestamp: 2 });
    expect(key1).not.toBe(key2);
  });
});

describe("extractPushName", () => {
  it("returns the sender's WhatsApp display name from _data.pushName", () => {
    const msg: WahaMessage = { _data: { pushName: "Marcos Vinícius Rubido" } };
    expect(extractPushName(msg)).toBe("Marcos Vinícius Rubido");
  });

  it("returns undefined when _data is missing", () => {
    expect(extractPushName({})).toBeUndefined();
  });

  it("returns undefined when _data.pushName is absent", () => {
    expect(extractPushName({ _data: {} })).toBeUndefined();
  });
});

describe("formatLocation", () => {
  it("includes the title alongside coordinates when present", () => {
    expect(formatLocation({ latitude: 38.8937255, longitude: -77.0969763, title: "Our office" })).toBe(
      "Our office (38.8937255, -77.0969763)",
    );
  });

  it("falls back to just coordinates when there's no title", () => {
    expect(formatLocation({ latitude: 1.5, longitude: 2.5 })).toBe("1.5, 2.5");
  });
});

describe("hasDownloadableMedia", () => {
  it("is true when hasMedia and a url are both present", () => {
    expect(hasDownloadableMedia({ hasMedia: true, media: { url: "http://x/f.jpg" } })).toBe(true);
  });

  it("is false when hasMedia is false", () => {
    expect(hasDownloadableMedia({ hasMedia: false, media: { url: "http://x/f.jpg" } })).toBe(false);
  });

  it("is false when there's no media url", () => {
    expect(hasDownloadableMedia({ hasMedia: true, media: {} })).toBe(false);
  });

  it("is false when WAHA reported a media error", () => {
    expect(
      hasDownloadableMedia({ hasMedia: true, media: { url: "http://x/f.jpg", error: "boom" } }),
    ).toBe(false);
  });
});

function historyMsg(overrides: Partial<WahaHistoryMessage> = {}): WahaHistoryMessage {
  return { id: "h1", body: "hi", fromMe: false, _data: { pushName: "Marcos" }, ...overrides };
}

describe("formatRecentMessages", () => {
  it("formats messages oldest-first with sender: text, given newest-first input", () => {
    const messages = [
      historyMsg({ id: "h2", body: "second" }),
      historyMsg({ id: "h1", body: "first" }),
    ];
    expect(formatRecentMessages(messages, "")).toBe("Marcos: first\nMarcos: second");
  });

  it("labels the bot's own past messages as 'You'", () => {
    const messages = [historyMsg({ fromMe: true, body: "earlier reply", _data: undefined })];
    expect(formatRecentMessages(messages, "")).toBe("You: earlier reply");
  });

  it("falls back to 'Someone' when the sender's push name is unavailable", () => {
    const messages = [historyMsg({ _data: undefined })];
    expect(formatRecentMessages(messages, "")).toBe("Someone: hi");
  });

  it("uses an [image]/[document] placeholder for a media message with no caption", () => {
    const messages = [
      historyMsg({ id: "h1", body: "", hasMedia: true, media: { mimetype: "image/jpeg", url: "u" } }),
      historyMsg({ id: "h2", body: "", hasMedia: true, media: { mimetype: "application/pdf", url: "u" } }),
    ];
    expect(formatRecentMessages(messages, "")).toBe("Marcos: [document]\nMarcos: [image]");
  });

  it("labels video and audio media by type, and falls back to [media] with no mimetype", () => {
    const messages = [
      historyMsg({ id: "h1", body: "", hasMedia: true, media: { mimetype: "video/mp4", url: "u" } }),
      historyMsg({ id: "h2", body: "", hasMedia: true, media: { mimetype: "audio/ogg", url: "u" } }),
      historyMsg({ id: "h3", body: "", hasMedia: true, media: { url: "u" } }),
    ];
    expect(formatRecentMessages(messages, "")).toBe("Marcos: [media]\nMarcos: [audio]\nMarcos: [video]");
  });

  it("excludes the message matching excludeMessageId", () => {
    const messages = [historyMsg({ id: "triggering", body: "the message that triggered this" })];
    expect(formatRecentMessages(messages, "triggering")).toBeUndefined();
  });

  it("skips messages with neither body nor media", () => {
    const messages = [historyMsg({ body: "", hasMedia: false })];
    expect(formatRecentMessages(messages, "")).toBeUndefined();
  });

  it("returns undefined when there are no messages left after filtering", () => {
    expect(formatRecentMessages([], "")).toBeUndefined();
  });

  it("caps at 15 messages even when more are given", () => {
    const messages = Array.from({ length: 20 }, (_, i) => historyMsg({ id: `h${String(i)}`, body: `m${String(i)}` }));
    const result = formatRecentMessages(messages, "");
    expect(result?.split("\n")).toHaveLength(15);
  });

  it("stops adding messages once the character budget is exceeded", () => {
    const big = "x".repeat(2000);
    const messages = [
      historyMsg({ id: "h1", body: big }),
      historyMsg({ id: "h2", body: big }),
      historyMsg({ id: "h3", body: big }),
    ];
    const result = formatRecentMessages(messages, "");
    expect(result?.split("\n")).toHaveLength(1);
  });
});

describe("selectRecentMedia", () => {
  it("returns messages with downloadable media, newest-first, up to RECENT_MEDIA_MAX", () => {
    const messages = [
      historyMsg({ id: "h1", hasMedia: true, media: { url: "u1" } }),
      historyMsg({ id: "h2", hasMedia: false }),
      historyMsg({ id: "h3", hasMedia: true, media: { url: "u3" } }),
      historyMsg({ id: "h4", hasMedia: true, media: { url: "u4" } }),
    ];
    const result = selectRecentMedia(messages, "");
    expect(result).toHaveLength(RECENT_MEDIA_MAX);
    expect(result.map((m) => m.id)).toEqual(["h1", "h3"]);
  });

  it("excludes the triggering message", () => {
    const messages = [historyMsg({ id: "triggering", hasMedia: true, media: { url: "u1" } })];
    expect(selectRecentMedia(messages, "triggering")).toEqual([]);
  });

  it("skips messages WAHA reported a media error for", () => {
    const messages = [historyMsg({ id: "h1", hasMedia: true, media: { url: "u1", error: "boom" } })];
    expect(selectRecentMedia(messages, "")).toEqual([]);
  });
});

function mentionHistoryMsg(id: string, mentionedId: string): WahaHistoryMessage {
  return {
    ...historyMsg({ id, body: `@${mentionedId} question` }),
    _data: { message: { extendedTextMessage: { contextInfo: { mentionedJid: [mentionedId] } } } },
  };
}

describe("trimSinceLastMention", () => {
  const isBotId = (id: string) => id === "bot123";

  it("excludes the triggering message and stops before an earlier mention of the bot", () => {
    // 10 messages newest-first; m10 is the trigger (excluded by id), m5 was an
    // earlier @-mention of the bot — only m9..m6 (already-unseen chatter) should carry over.
    const messages = [
      historyMsg({ id: "m10", body: "the message that triggered this run" }),
      historyMsg({ id: "m9", body: "nine" }),
      historyMsg({ id: "m8", body: "eight" }),
      historyMsg({ id: "m7", body: "seven" }),
      historyMsg({ id: "m6", body: "six" }),
      mentionHistoryMsg("m5", "bot123"),
      historyMsg({ id: "m4", body: "four" }),
    ];
    const result = trimSinceLastMention(messages, "m10", isBotId);
    expect(result.map((m) => m.id)).toEqual(["m9", "m8", "m7", "m6"]);
  });

  it("returns everything (up to what was fetched) when the bot was never mentioned before", () => {
    const messages = [historyMsg({ id: "m2" }), historyMsg({ id: "m1" })];
    expect(trimSinceLastMention(messages, "", isBotId).map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("returns an empty array when the very previous message already mentioned the bot", () => {
    const messages = [mentionHistoryMsg("m1", "bot123")];
    expect(trimSinceLastMention(messages, "", isBotId)).toEqual([]);
  });

  it("ignores a mention of someone other than the bot", () => {
    const messages = [mentionHistoryMsg("m1", "someoneElse456")];
    expect(trimSinceLastMention(messages, "", isBotId).map((m) => m.id)).toEqual(["m1"]);
  });

  it("stops at the nearest of two prior mentions, not the older one", () => {
    // Two separate earlier @-mention exchanges (m7 and m3) — only the chatter
    // since the MORE RECENT one (m7) should carry over, not all the way back to m3.
    const messages = [
      historyMsg({ id: "m10", body: "trigger" }),
      historyMsg({ id: "m9", body: "nine" }),
      historyMsg({ id: "m8", body: "eight" }),
      mentionHistoryMsg("m7", "bot123"),
      historyMsg({ id: "m6", body: "six" }),
      historyMsg({ id: "m5", body: "five" }),
      mentionHistoryMsg("m3", "bot123"),
      historyMsg({ id: "m2", body: "two" }),
    ];
    const result = trimSinceLastMention(messages, "m10", isBotId);
    expect(result.map((m) => m.id)).toEqual(["m9", "m8"]);
  });

  it("returns an empty array for two back-to-back mentions with nothing new in between", () => {
    const messages = [
      historyMsg({ id: "m10", body: "trigger, second mention right after the first" }),
      mentionHistoryMsg("m9", "bot123"),
      historyMsg({ id: "m8", body: "eight" }),
    ];
    expect(trimSinceLastMention(messages, "m10", isBotId)).toEqual([]);
  });
});
