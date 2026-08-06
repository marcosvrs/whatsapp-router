import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessionStore.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-test-"));
  filePath = join(dir, "nested", "sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("returns undefined for an unknown sender", () => {
    const store = new SessionStore(filePath);
    expect(store.get("alice")).toBeUndefined();
  });

  it("stores and retrieves a session id", () => {
    const store = new SessionStore(filePath);
    store.set("alice", "ses_1");
    expect(store.get("alice")).toBe("ses_1");
  });

  it("persists across instances (survives a restart)", () => {
    const store1 = new SessionStore(filePath);
    store1.set("alice", "ses_1");

    const store2 = new SessionStore(filePath);
    expect(store2.get("alice")).toBe("ses_1");
  });

  it("creates the parent directory if it doesn't exist", () => {
    const store = new SessionStore(filePath);
    store.set("alice", "ses_1");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toHaveProperty("alice");
  });

  it("reset removes the mapping", () => {
    const store = new SessionStore(filePath);
    store.set("alice", "ses_1");
    store.reset("alice");
    expect(store.get("alice")).toBeUndefined();
  });

  it("reset persists across instances", () => {
    const store1 = new SessionStore(filePath);
    store1.set("alice", "ses_1");
    store1.reset("alice");

    const store2 = new SessionStore(filePath);
    expect(store2.get("alice")).toBeUndefined();
  });

  it("touch updates the entry without changing the session id", () => {
    const store = new SessionStore(filePath);
    store.set("alice", "ses_1");
    store.touch("alice");
    expect(store.get("alice")).toBe("ses_1");
  });

  it("touch on an unknown sender is a no-op, not an error", () => {
    const store = new SessionStore(filePath);
    expect(() => {
      store.touch("nobody");
    }).not.toThrow();
  });

  it("starts empty when the file contains invalid JSON", () => {
    mkdtempSync(dir);
    const store = new SessionStore(join(dir, "does-not-exist.json"));
    expect(store.get("alice")).toBeUndefined();
  });
});
