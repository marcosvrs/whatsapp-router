// Serializes calls per key so two rapid calls for the same key can't both see
// "no cached session" and each create one, silently orphaning one.
export class SenderLock {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === gate) this.locks.delete(key);
    }
  }
}
