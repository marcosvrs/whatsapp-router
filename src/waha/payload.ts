interface WahaMessageContextInfo {
  contextInfo?: {
    mentionedJid?: string[];
  };
}

export interface WahaMessageMedia {
  url?: string | null;
  mimetype?: string;
  filename?: string | null;
  error?: string | null;
}

export interface WahaMessage {
  id?: string;
  from?: string;
  fromMe?: boolean;
  body?: string;
  timestamp?: number;
  participant?: string;
  hasMedia?: boolean;
  media?: WahaMessageMedia;
  _data?: {
    message?: {
      extendedTextMessage?: WahaMessageContextInfo;
      // Mirrors extendedTextMessage's shape per WhatsApp's standard (Baileys)
      // protocol — unlike the text case above, this hasn't been confirmed
      // against a live payload, so verify against a real mentioned-in-caption
      // message if group mention detection on media doesn't work as expected.
      imageMessage?: WahaMessageContextInfo;
      documentMessage?: WahaMessageContextInfo;
      videoMessage?: WahaMessageContextInfo;
    };
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
// as _data.message.extendedTextMessage.contextInfo.mentionedJid. Image/document/
// video captions are assumed to mirror that shape under their own message-type
// key (see the caveat on WahaMessage) — replies aren't handled at all, still
// untested/unguessed at.
export function extractMentionedIds(msg: WahaMessage): string[] {
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

export function messageDedupeKey(msg: WahaMessage): string {
  return msg.id ?? `${msg.from ?? ""}|${msg.body ?? ""}|${String(msg.timestamp ?? "")}`;
}
