import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("starts empty when the file contains invalid JSON", () => {
    mkdtempSync(dir);
    const store = new SessionStore(join(dir, "does-not-exist.json"));
    expect(store.get("alice")).toBeUndefined();
  });

  it("starts empty when the file contains a JSON array instead of an object", () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "[]");
    const store = new SessionStore(filePath);
    expect(store.get("alice")).toBeUndefined();
  });

  it("starts empty when the file contains a bare JSON null", () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "null");
    const store = new SessionStore(filePath);
    expect(store.get("alice")).toBeUndefined();
  });

  it("starts empty when the file contains a bare JSON number", () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "42");
    const store = new SessionStore(filePath);
    expect(store.get("alice")).toBeUndefined();
  });

  it("logs the exact failure message when the file can't be written", () => {
    // Make the parent path a file instead of a directory, so mkdirSync fails.
    const blockerPath = join(dir, "blocker");
    writeFileSync(blockerPath, "not a directory");
    const badFilePath = join(blockerPath, "sessions.json");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = new SessionStore(badFilePath);
    store.set("alice", "ses_1");

    expect(logSpy).toHaveBeenCalledTimes(1);
    const args = logSpy.mock.calls[0] as unknown[];
    expect(args[1]).toBe("saveSessions failed");
    logSpy.mockRestore();
  });
});
