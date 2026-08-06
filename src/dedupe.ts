// WAHA fires the webhook more than once for the same inbound message (observed:
// identical event, same millisecond timestamp). De-dupe by message key so we
// don't spawn concurrent opencode/Firefly/HA calls for one message.
export class MessageDedupe {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  alreadyProcessed(key: string, now = Date.now()): boolean {
    for (const [k, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(k);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }
}
