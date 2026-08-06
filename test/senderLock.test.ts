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
});
