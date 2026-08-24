import { describe, expect, it } from "vitest";
import { MessageDedupe } from "../src/dedupe.js";

describe("MessageDedupe", () => {
  it("returns false the first time a key is seen", () => {
    const dedupe = new MessageDedupe(1000);
    expect(dedupe.alreadyProcessed("a", 0)).toBe(false);
  });

  it("returns true for a repeat of the same key within the ttl", () => {
    const dedupe = new MessageDedupe(1000);
    dedupe.alreadyProcessed("a", 0);
    expect(dedupe.alreadyProcessed("a", 1)).toBe(true);
  });

  it("returns false again once the ttl has elapsed", () => {
    const dedupe = new MessageDedupe(1000);
    dedupe.alreadyProcessed("a", 0);
    expect(dedupe.alreadyProcessed("a", 1001)).toBe(false);
  });
  it("treats a hit exactly at the ttl as still duplicated", () => {
    const dedupe = new MessageDedupe(1000);
    dedupe.alreadyProcessed("a", 0);
    expect(dedupe.alreadyProcessed("a", 1000)).toBe(true);
  });


  it("treats different keys independently", () => {
    const dedupe = new MessageDedupe(1000);
    dedupe.alreadyProcessed("a", 0);
    expect(dedupe.alreadyProcessed("b", 0)).toBe(false);
  });
});
