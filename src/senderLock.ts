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
    const lock = prev.then(() => gate);
    this.locks.set(key, lock);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === lock) this.locks.delete(key);
    }
  }
}
