import { describe, expect, it } from "vitest";
import { SenderLock } from "../src/senderLock.js";

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SenderLock", () => {
  it("runs a single call and returns its result", async () => {
    const lock = new SenderLock();
    const result = await lock.run("a", () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("serializes two concurrent calls for the same key", async () => {
    const lock = new SenderLock();
    const order: string[] = [];
    const first = deferredVoid();

    const call1 = lock.run("a", async () => {
      order.push("call1 start");
      await first.promise;
      order.push("call1 end");
    });

    const call2 = lock.run("a", () => {
      order.push("call2 start");
      order.push("call2 end");
      return Promise.resolve();
    });

    // call2 must not have started yet — it's waiting on call1's gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["call1 start"]);

    first.resolve();
    await Promise.all([call1, call2]);

    expect(order).toEqual(["call1 start", "call1 end", "call2 start", "call2 end"]);
  });

  it("does not serialize calls for different keys", async () => {
    const lock = new SenderLock();
    const order: string[] = [];
    const first = deferredVoid();

    const call1 = lock.run("a", async () => {
      order.push("a start");
      await first.promise;
      order.push("a end");
    });

    const call2 = lock.run("b", () => {
      order.push("b start");
      order.push("b end");
      return Promise.resolve();
    });

    await call2;
    expect(order).toEqual(["a start", "b start", "b end"]);

    first.resolve();
    await call1;
    expect(order).toEqual(["a start", "b start", "b end", "a end"]);
  });

  it("releases the lock even when the callback throws", async () => {
    const lock = new SenderLock();
    await expect(
      lock.run("a", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    const result = await lock.run("a", () => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
  });

  it("keeps a third call waiting on a second, even though the second started after the first finished (map entry must not be cleared early)", async () => {
    const lock = new SenderLock();
    const order: string[] = [];
    const gate1 = deferredVoid();
    const gate2 = deferredVoid();

    const call1 = lock.run("a", async () => {
      order.push("1 start");
      await gate1.promise;
      order.push("1 end");
    });

    const call2 = lock.run("a", async () => {
      order.push("2 start");
      await gate2.promise;
      order.push("2 end");
    });

    gate1.resolve();
    await call1;
    // call2 must already be queued behind call1 — it must not have started yet.
    expect(order).toEqual(["1 start", "1 end"]);

    const call3 = lock.run("a", () => {
      order.push("3 start");
      return Promise.resolve();
    });

    // call3 must wait for call2, not run immediately just because call1 (the
    // lock's *previous* entry) already finished and got cleaned up.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).not.toContain("3 start");

    gate2.resolve();
    await Promise.all([call2, call3]);
    expect(order).toEqual(["1 start", "1 end", "2 start", "2 end", "3 start"]);
  });
});
