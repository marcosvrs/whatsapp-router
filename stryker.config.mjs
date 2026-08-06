/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  reporters: ["html", "clear-text", "progress"],
  coverageAnalysis: "perTest",
  mutate: ["src/**/*.ts", "!src/index.ts"],
  thresholds: { high: 85, low: 75, break: 70 },
};
