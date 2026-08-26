import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { error } from "./log.js";

export interface DeliveryRetryEntry {
  senderKey: string;
  messageId: string;
  text: string;
  chatId: string;
  attempts: number;
}

function isEntry(value: unknown): value is DeliveryRetryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.senderKey === "string" &&
    typeof entry.messageId === "string" &&
    typeof entry.text === "string" &&
    typeof entry.chatId === "string" &&
    typeof entry.attempts === "number"
  );
}

function load(filePath: string): DeliveryRetryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export class DeliveryRetryStore {
  private readonly entries = new Map<string, DeliveryRetryEntry>();

  constructor(private readonly filePath: string) {
    for (const entry of load(filePath)) this.entries.set(this.key(entry.senderKey, entry.messageId), entry);
  }

  list(senderKey: string): DeliveryRetryEntry[] {
    return [...this.entries.values()].filter((entry) => entry.senderKey === senderKey);
  }

  listAll(): DeliveryRetryEntry[] {
    return [...this.entries.values()];
  }

  set(entry: DeliveryRetryEntry): void {
    this.entries.set(this.key(entry.senderKey, entry.messageId), entry);
    this.save();
  }

  delete(senderKey: string, messageId: string): void {
    if (!this.entries.delete(this.key(senderKey, messageId))) return;
    this.save();
  }

  clear(senderKey: string): void {
    for (const entry of this.list(senderKey)) this.delete(senderKey, entry.messageId);
  }

  private key(senderKey: string, messageId: string): string {
    return `${senderKey}:${messageId}`;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.entries.values()]));
    } catch (err) {
      error("saveDeliveryRetries failed", err instanceof Error ? err.message : String(err));
    }
  }
}
