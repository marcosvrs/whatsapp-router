import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryRetryStore } from "../src/deliveryRetryStore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-delivery-retries-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DeliveryRetryStore", () => {
  it("persists entries and reloads them by sender", () => {
    const filePath = join(dir, "retries.json");
    const first = new DeliveryRetryStore(filePath);
    first.set({ senderKey: "111", messageId: "msg_1", text: "hello", chatId: "chat1", attempts: 1 });
    first.set({ senderKey: "222", messageId: "msg_2", text: "other", chatId: "chat2", attempts: 0 });

    const second = new DeliveryRetryStore(filePath);
    expect(second.list("111")).toEqual([
      { senderKey: "111", messageId: "msg_1", text: "hello", chatId: "chat1", attempts: 1 },
    ]);
    expect(second.list("222")).toEqual([
      { senderKey: "222", messageId: "msg_2", text: "other", chatId: "chat2", attempts: 0 },
    ]);
    expect(readFileSync(filePath, "utf8")).toContain("msg_1");
  });

  it("deletes an entry and ignores missing entries", () => {
    const store = new DeliveryRetryStore(join(dir, "retries.json"));
    store.set({ senderKey: "111", messageId: "msg_1", text: "hello", chatId: "chat1", attempts: 0 });
    store.delete("111", "msg_1");
    store.delete("111", "missing");
    expect(store.list("111")).toEqual([]);
  });
  it("keeps in-memory entries when the persistence path is unavailable", () => {
    const store = new DeliveryRetryStore(dir);
    store.set({ senderKey: "111", messageId: "msg_1", text: "hello", chatId: "chat1", attempts: 0 });
    expect(store.list("111")).toHaveLength(1);
  });
  it("ignores malformed persisted payloads", () => {
    const arrayPath = join(dir, "malformed-array.json");
    const valid = { senderKey: "111", messageId: "msg_1", text: "hello", chatId: "chat1", attempts: 0 };
    const malformed = [
      { ...valid, senderKey: 111 },
      { ...valid, messageId: 1 },
      { ...valid, text: 1 },
      { ...valid, chatId: 1 },
      { ...valid, attempts: "0" },
    ];
    writeFileSync(arrayPath, JSON.stringify([null, ...malformed]));
    expect(new DeliveryRetryStore(arrayPath).list("111")).toEqual([]);

    const objectPath = join(dir, "malformed-object.json");
    writeFileSync(objectPath, JSON.stringify({ senderKey: "111" }));
    expect(new DeliveryRetryStore(objectPath).list("111")).toEqual([]);
  });
});