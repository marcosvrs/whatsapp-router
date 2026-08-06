import type { IdentityResolver } from "./waha/identity.js";
import { extractMentionedIds, type WahaMessage } from "./waha/payload.js";

// Resolves the sender to a phone number and returns it only if allowed to
// trigger the bot — null otherwise. For 1:1 chats: sender must be allowlisted.
// For group chats (any group, not just specific approved ones): the actual
// sender (msg.participant) must be allowlisted AND the bot must be
// @-mentioned — otherwise ordinary group chatter is silently ignored.
// The resolved phone (not the raw jid, and not the group jid) is used as the
// session-store key so a sender keeps one conversation across 1:1 and group.
export async function resolveAllowedSender(
  identity: IdentityResolver,
  allowedUsers: Set<string>,
  fromJid: string | undefined,
  msg: WahaMessage,
): Promise<string | null> {
  await identity.ensureLidMap();

  if ((fromJid ?? "").endsWith("@g.us")) {
    await identity.ensureBotIds();
    const mentioned = extractMentionedIds(msg).some((id) => identity.isBotId(id));
    if (!mentioned) return null;
    const participantPhone = identity.resolvePhone(msg.participant);
    return participantPhone && allowedUsers.has(participantPhone) ? participantPhone : null;
  }

  const phone = identity.resolvePhone(fromJid);
  return phone && allowedUsers.has(phone) ? phone : null;
}
