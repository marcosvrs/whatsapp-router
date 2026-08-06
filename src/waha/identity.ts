import { log } from "../log.js";
import type { WahaClientLike } from "./client.js";

const LID_MAP_TTL_MS = 5 * 60 * 1000;

export interface IdentityResolver {
  ensureLidMap: () => Promise<void>;
  ensureBotIds: () => Promise<void>;
  resolvePhone: (jid: string | undefined) => string | undefined;
  isBotId: (id: string) => boolean;
}

// WhatsApp's privacy-ID layer means inbound senders can show up as "<lid>@lid"
// instead of "<phone>@c.us". WAHA's own /lids resolver needs its NOWEB store to
// have synced (unreliable, can take a long time), so resolve via group
// participant lists instead — those carry both id (lid) and phoneNumber directly.
export class Identity implements IdentityResolver {
  private lidToPhone = new Map<string, string>();
  private lidMapLoadedAt = 0;
  private readonly botIds = new Set<string>();
  private botIdsLoaded = false;

  constructor(private readonly waha: WahaClientLike) {}

  async ensureLidMap(): Promise<void> {
    if (Date.now() - this.lidMapLoadedAt <= LID_MAP_TTL_MS) return;
    try {
      const groups = await this.waha.fetchGroups();
      const map = new Map<string, string>();
      for (const group of Object.values(groups)) {
        for (const p of group.participants ?? []) {
          if (p.id && p.phoneNumber) {
            map.set(p.id.split("@")[0] ?? "", p.phoneNumber.split("@")[0] ?? "");
          }
        }
      }
      this.lidToPhone = map;
      this.lidMapLoadedAt = Date.now();
      log("lid map refreshed", map.size, "entries");
    } catch (err) {
      log("lid map refresh failed", err instanceof Error ? err.message : String(err));
    }
  }

  resolvePhone(jid: string | undefined): string | undefined {
    const raw = (jid ?? "").split("@")[0] ?? "";
    if ((jid ?? "").endsWith("@lid")) return this.lidToPhone.get(raw);
    return raw;
  }

  // The bot's own identifiers (both phone-based and @lid forms), used to detect
  // when it's @-mentioned in a group. Fetched from WAHA's own session info once
  // and cached forever — unlike group membership this doesn't change at runtime,
  // only by re-scanning a different number onto the session, which warrants a
  // restart anyway (same as every other WAHA session-config change).
  async ensureBotIds(): Promise<void> {
    if (this.botIdsLoaded) return;
    try {
      const info = await this.waha.fetchSessionInfo();
      if (!info) return;
      if (info.me?.id) this.botIds.add(info.me.id.split("@")[0] ?? "");
      if (info.me?.lid) this.botIds.add(info.me.lid.split("@")[0] ?? "");
      this.botIdsLoaded = true;
      log("bot ids loaded", [...this.botIds].join(","));
    } catch (err) {
      log("bot ids load failed", err instanceof Error ? err.message : String(err));
    }
  }

  isBotId(id: string): boolean {
    return this.botIds.has(id);
  }
}
