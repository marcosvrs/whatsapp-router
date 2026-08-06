interface WahaMessageContextInfo {
  contextInfo?: {
    mentionedJid?: string[];
  };
}

// Shared by WahaMessage (the live webhook payload) and WahaHistoryMessage
// (chat-history REST responses) — both carry mentions in this same shape,
// confirmed against live payloads from both sources.
interface WahaMentionContainer {
  _data?: {
    message?: {
      extendedTextMessage?: WahaMessageContextInfo;
      imageMessage?: WahaMessageContextInfo;
      documentMessage?: WahaMessageContextInfo;
      videoMessage?: WahaMessageContextInfo;
    };
  };
}

export interface WahaMessageMedia {
  url?: string | null;
  mimetype?: string;
  filename?: string | null;
  error?: string | null;
}

export interface WahaReplyTo {
  body?: string;
}

// Mirrors WAHA's send-location request shape ({latitude, longitude, title})
// — not independently confirmed on the receive side against a live payload.
export interface WahaLocation {
  latitude?: number;
  longitude?: number;
  title?: string | null;
}

// The shape returned by GET /api/{session}/chats/{chatId}/messages — confirmed
// against live group history (id, timestamp, fromMe, participant, body,
// hasMedia, _data.pushName all present exactly as used below).
// The shape returned by GET /api/{session}/chats/{chatId}/messages — confirmed
// against live group history (id, body, fromMe, hasMedia, media, _data.pushName,
// and the mention shape below all present exactly as used here).
export interface WahaHistoryMessage extends WahaMentionContainer {
  id?: string;
  body?: string;
  fromMe?: boolean;
  hasMedia?: boolean;
  media?: WahaMessageMedia;
  _data?: WahaMentionContainer["_data"] & {
    pushName?: string;
  };
}

export interface WahaMessage extends WahaMentionContainer {
  id?: string;
  from?: string;
  fromMe?: boolean;
  body?: string;
  timestamp?: number;
  participant?: string;
  hasMedia?: boolean;
  media?: WahaMessageMedia;
  location?: WahaLocation;
  replyTo?: WahaReplyTo;
  // pushName is the sender's WhatsApp display name — confirmed against a
  // live payload (via the REST chat-history endpoint; not shown in WAHA's
  // own webhook docs examples, but the same underlying message shape).
  _data?: WahaMentionContainer["_data"] & {
    pushName?: string;
  };
}

export interface WahaWebhookPayload {
  event?: string;
  payload?: WahaMessage;
}

export function stripJidSuffix(jid: string | undefined): string {
  return (jid ?? "").split("@")[0] ?? "";
}

// Confirmed against a live payload: an @-mentioned plain-text message arrives
// as _data.message.extendedTextMessage.contextInfo.mentionedJid. Image/document
// captions confirmed the same way (pulled from real group chat history);
// video captions are assumed to mirror that shape but not independently
// confirmed. Replies aren't handled at all, still untested/unguessed at.
// Takes the shared WahaMentionContainer shape so it works for both the live
// webhook payload (WahaMessage) and chat-history results (WahaHistoryMessage).
export function extractMentionedIds(msg: WahaMentionContainer): string[] {
  const message = msg._data?.message;
  const mentioned =
    message?.extendedTextMessage?.contextInfo?.mentionedJid ??
    message?.imageMessage?.contextInfo?.mentionedJid ??
    message?.documentMessage?.contextInfo?.mentionedJid ??
    message?.videoMessage?.contextInfo?.mentionedJid;
  return Array.isArray(mentioned) ? mentioned.map(stripJidSuffix) : [];
}

export function stripMentions(text: string, msg: WahaMessage): string {
  let out = text;
  for (const id of extractMentionedIds(msg)) out = out.replaceAll(`@${id}`, "");
  return out.trim();
}

export function extractPushName(msg: WahaMessage): string | undefined {
  return msg._data?.pushName;
}

export function formatLocation(location: WahaLocation): string {
  const coords = `${String(location.latitude ?? "?")}, ${String(location.longitude ?? "?")}`;
  return location.title ? `${location.title} (${coords})` : coords;
}

export function messageDedupeKey(msg: WahaMessage): string {
  return msg.id ?? `${msg.from ?? ""}|${msg.body ?? ""}|${String(msg.timestamp ?? "")}`;
}

// WAHA reports hasMedia:true even when it couldn't fetch the file itself
// (media.error set, media.url null) — only worth downloading when there's an
// actual url to fetch. Shared by the live message and chat-history messages.
export function hasDownloadableMedia(msg: { hasMedia?: boolean; media?: WahaMessageMedia }): boolean {
  return Boolean(msg.hasMedia && msg.media?.url && !msg.media.error);
}

function mediaTypeLabel(mimetype: string | undefined): string {
  if (!mimetype) return "media";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "audio";
  return "document";
}

// How many messages to request from WAHA before filtering/capping — needs
// headroom over RECENT_MESSAGES_MAX_COUNT since the triggering message itself,
// anything at or before an earlier bot mention, and empty/no-caption media
// messages all get filtered out afterward.
export const RECENT_MESSAGES_FETCH_LIMIT = 25;

// At most this many media items (images/documents/etc.) from the recent
// history get downloaded and forwarded as actual attachments — bounded
// separately from the text cap since each one costs real bandwidth and
// multimodal tokens, not just a line of text.
export const RECENT_MEDIA_MAX = 2;

const RECENT_MESSAGES_MAX_COUNT = 15;
const RECENT_MESSAGES_MAX_CHARS = 2500;

// Trims WAHA's chat history (newest-first) down to only what's new since the
// bot was last involved: drops the message that triggered this run (matched
// by id) and stops — without including — the first earlier message that
// itself @-mentions the bot, since anything at or before that point was
// already sent to the agent in a prior turn.
export function trimSinceLastMention(
  messages: WahaHistoryMessage[],
  excludeMessageId: string,
  isBotId: (id: string) => boolean,
): WahaHistoryMessage[] {
  const result: WahaHistoryMessage[] = [];
  for (const msg of messages) {
    if (msg.id === excludeMessageId) continue;
    if (extractMentionedIds(msg).some(isBotId)) break;
    result.push(msg);
  }
  return result;
}

// WAHA returns chat history newest-first. Bounded by both a message-count cap
// and a character budget — whichever hits first — so neither one long
// message nor a burst of short ones can blow the context sent on every
// @-mention. Reversed to chronological order once the cap is applied.
export function formatRecentMessages(
  messages: WahaHistoryMessage[],
  excludeMessageId: string,
): string | undefined {
  const lines: string[] = [];
  let chars = 0;
  for (const msg of messages) {
    if (msg.id === excludeMessageId) continue;
    if (lines.length >= RECENT_MESSAGES_MAX_COUNT) break;
    const text = (msg.body ?? "").trim() || (msg.hasMedia ? `[${mediaTypeLabel(msg.media?.mimetype)}]` : "");
    if (!text) continue;
    const sender = msg.fromMe ? "You" : (msg._data?.pushName ?? "Someone");
    const line = `${sender}: ${text}`;
    if (chars + line.length > RECENT_MESSAGES_MAX_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  return lines.length ? lines.reverse().join("\n") : undefined;
}

// Newest-first, capped at RECENT_MEDIA_MAX — the most recent downloadable
// media items in the (already trimmed) history window.
export function selectRecentMedia(
  messages: WahaHistoryMessage[],
  excludeMessageId: string,
): WahaHistoryMessage[] {
  const result: WahaHistoryMessage[] = [];
  for (const msg of messages) {
    if (msg.id === excludeMessageId) continue;
    if (!hasDownloadableMedia(msg)) continue;
    result.push(msg);
    if (result.length >= RECENT_MEDIA_MAX) break;
  }
  return result;
}
