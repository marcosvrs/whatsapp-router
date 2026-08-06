import { describe, expect, it } from "vitest";
import { normalizeAmount } from "../src/amount.js";

describe("normalizeAmount", () => {
  it("passes through a plain integer", () => {
    expect(normalizeAmount("20")).toBe("20");
  });

  it("passes through a plain decimal", () => {
    expect(normalizeAmount("20.50")).toBe("20.50");
  });

  it("treats a lone comma as a decimal separator", () => {
    expect(normalizeAmount("20,50")).toBe("20.50");
  });

  it("treats comma-before-dot as thousands separator (US style)", () => {
    expect(normalizeAmount("1,234.56")).toBe("1234.56");
  });

  it("treats dot-before-comma as thousands separator (EU style)", () => {
    expect(normalizeAmount("1.234,56")).toBe("1234.56");
  });

  it("strips whitespace", () => {
    expect(normalizeAmount("  20.50  ")).toBe("20.50");
  });

  it("returns null for non-numeric input", () => {
    expect(normalizeAmount("abc")).toBeNull();
  });

  it("returns null for multiple decimal points after normalization", () => {
    expect(normalizeAmount("1.2.3")).toBeNull();
  });

  it("strips every thousands separator, not just the first, in US style", () => {
    expect(normalizeAmount("1,234,567.89")).toBe("1234567.89");
  });

  it("returns null for multiple lone commas with no dot (ambiguous, only the first is treated as decimal)", () => {
    expect(normalizeAmount("1,234,567")).toBeNull();
  });

  it("returns null for a trailing decimal point with no digits after it", () => {
    expect(normalizeAmount("20.")).toBeNull();
  });

  it("returns null for a leading decimal point with no digits before it", () => {
    expect(normalizeAmount(".50")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeAmount("")).toBeNull();
  });

  it("returns null for a negative number (not supported)", () => {
    expect(normalizeAmount("-20")).toBeNull();
  });
});
