import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stryker = readFileSync(new URL("../stryker.config.mjs", import.meta.url), "utf8");
const fastPush = readFileSync(new URL("../.github/workflows/fast-push.yaml", import.meta.url), "utf8");
const mutation = readFileSync(new URL("../.github/workflows/mutation-testing.yaml", import.meta.url), "utf8");
const image = readFileSync(new URL("../.github/workflows/build-and-push-image.yaml", import.meta.url), "utf8");

describe("CI cache configuration", () => {
  it("enables Stryker incremental reports and restores the trusted main cache", () => {
    expect(stryker).toContain("incremental: true");
    expect(stryker).toContain('incrementalFile: "reports/stryker-incremental.json"');
    expect(fastPush).toContain("reports/stryker-incremental.json");
    expect(mutation).toContain("actions/cache/restore@");
    expect(mutation).toContain("actions/cache/save@");
  });

  it("uses a persistent BuildKit layer cache for image publishing", () => {
    expect(image).toContain("cache-from: type=gha,scope=whatsapp-router-image");
    expect(image).toContain("cache-to: type=gha,mode=max,scope=whatsapp-router-image");
  });
});
