import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log", () => {
  it("prefixes the arguments with an ISO timestamp and passes them through", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log("hello", 42, { a: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    const [timestamp, ...rest] = spy.mock.calls[0] as [string, ...unknown[]];
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rest).toEqual(["hello", 42, { a: 1 }]);
  });

  it("works with no arguments", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
  });
});
