/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  reporters: ["html", "clear-text", "progress"],
  coverageAnalysis: "perTest",
  mutate: ["src/**/*.ts", "!src/index.ts"],
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  thresholds: { high: 95, low: 90, break: 85 },
};
