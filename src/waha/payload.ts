export interface WahaMessage {
  id?: string;
  from?: string;
  fromMe?: boolean;
  body?: string;
  timestamp?: number;
  participant?: string;
  _data?: {
    message?: {
      extendedTextMessage?: {
        contextInfo?: {
          mentionedJid?: string[];
        };
      };
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
// as _data.message.extendedTextMessage.contextInfo.mentionedJid. Other message
// types (image/video captions, replies) aren't handled — untested shapes, so
// left alone rather than guessed at.
export function extractMentionedIds(msg: WahaMessage): string[] {
  const mentioned = msg._data?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
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
