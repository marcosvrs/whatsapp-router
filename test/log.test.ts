import { afterEach, describe, expect, it, vi } from "vitest";
import { debug, error, getLogLevel, info, parseLogLevel, setLogLevel, warn } from "../src/log.js";

afterEach(() => {
  setLogLevel("info");
  vi.restoreAllMocks();
});

describe("leveled logger", () => {
  it("prefixes info arguments with an ISO timestamp and level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    info("hello", 42, { a: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    const [prefix, ...rest] = spy.mock.calls[0] as [string, ...unknown[]];
    expect(prefix).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\]$/);
    expect(rest).toEqual(["hello", 42, { a: 1 }]);
  });

  it("filters below the configured minimum level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    setLogLevel("warn");

    debug("hidden debug");
    info("hidden info");
    warn("visible warning");
    error("visible error");

    expect(spy.mock.calls).toHaveLength(2);
    const logged = spy.mock.calls.map((call: unknown[]): [unknown, unknown] => [call[0], call[1]]);
    expect(logged).toEqual([
      [expect.stringMatching(/ \[WARN\]$/), "visible warning"],
      [expect.stringMatching(/ \[ERROR\]$/), "visible error"],
    ]);
    expect(getLogLevel()).toBe("warn");
  });

  it("parses supported and unknown environment values", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" info ")).toBe("info");
    expect(parseLogLevel("warning")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
  });

  it("logs an info entry with no payload", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    info();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
  });
});
