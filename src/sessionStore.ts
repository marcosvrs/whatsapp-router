import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";

interface SessionEntry {
  sessionId: string;
  updatedAt: number;
}

function isSessionRecord(value: unknown): value is Record<string, SessionEntry> {
  return typeof value === "object" && value !== null;
}

function loadFromDisk(filePath: string): Map<string, SessionEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (isSessionRecord(parsed)) return new Map(Object.entries(parsed));
  } catch {
    // no existing file, or unreadable — start empty
  }
  return new Map();
}

// One opencode session per WhatsApp sender, persisted to disk so it survives
// container restarts. reset() drops the mapping so the next message starts fresh.
export class SessionStore {
  private readonly sessions: Map<string, SessionEntry>;

  constructor(private readonly filePath: string) {
    this.sessions = loadFromDisk(filePath);
  }

  get(senderKey: string): string | undefined {
    return this.sessions.get(senderKey)?.sessionId;
  }

  set(senderKey: string, sessionId: string): void {
    this.sessions.set(senderKey, { sessionId, updatedAt: Date.now() });
    this.save();
  }

  touch(senderKey: string): void {
    const entry = this.sessions.get(senderKey);
    if (entry) entry.updatedAt = Date.now();
    this.save();
  }

  reset(senderKey: string): void {
    this.sessions.delete(senderKey);
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.sessions)));
    } catch (err) {
      log("saveSessions failed", err instanceof Error ? err.message : String(err));
    }
  }
}
