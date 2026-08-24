import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { safeEqual, validWebhookSignature } from "../src/security.js";

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeEqual("secreu", "secret")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(safeEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns false when the first value is undefined", () => {
    expect(safeEqual(undefined, "secret")).toBe(false);
  });

  it("does not substitute a value for an undefined secret", () => {
    expect(safeEqual(undefined, "Stryker was here")).toBe(false);
  });
});

describe("validWebhookSignature", () => {
  const secret = "test-secret";
  const body = '{"event":"message"}';

  it("accepts a correctly signed body", () => {
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    expect(validWebhookSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(validWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = createHmac("sha512", "wrong-secret").update(body).digest("hex");
    expect(validWebhookSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a signature with an unexpected length without invoking timingSafeEqual", () => {
    expect(validWebhookSignature(body, "wrong-length", secret)).toBe(false);
  });

  it("rejects a signature for a tampered body", () => {
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    expect(validWebhookSignature('{"event":"tampered"}', signature, secret)).toBe(false);
  });
});
