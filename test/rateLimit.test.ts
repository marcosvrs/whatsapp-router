import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rateLimit.js";

describe("RateLimiter", () => {
  it("allows calls under the max within the window", () => {
    const limiter = new RateLimiter(3, 1000);
    const now = 1_000_000;
    expect(limiter.isLimited("a", now)).toBe(false);
    expect(limiter.isLimited("a", now + 1)).toBe(false);
    expect(limiter.isLimited("a", now + 2)).toBe(false);
  });

  it("limits once the max is reached within the window", () => {
    const limiter = new RateLimiter(2, 1000);
    const now = 1_000_000;
    expect(limiter.isLimited("a", now)).toBe(false);
    expect(limiter.isLimited("a", now + 1)).toBe(false);
    expect(limiter.isLimited("a", now + 2)).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const limiter = new RateLimiter(1, 1000);
    const now = 1_000_000;
    expect(limiter.isLimited("a", now)).toBe(false);
    expect(limiter.isLimited("b", now)).toBe(false);
  });

  it("allows calls again once old hits fall outside the window", () => {
    const limiter = new RateLimiter(1, 1000);
    const now = 1_000_000;
    expect(limiter.isLimited("a", now)).toBe(false);
    expect(limiter.isLimited("a", now + 1001)).toBe(false);
  });
});
