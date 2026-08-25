import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = [
  ".github/workflows/lint-build-test.yaml",
  ".github/workflows/mutation-testing.yaml",
].map((path) => ({ path, source: readFileSync(new URL(`../${path}`, import.meta.url), "utf8") }));

describe("pull request workflow runner security", () => {
  it.each(workflows)("routes $path pull requests to GitHub-hosted runners", ({ source }) => {
    expect(source).toMatch(
      /runs-on:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*&&\s*'ubuntu-latest'\s*\|\|\s*'self-hosted'\s*\}\}/,
    );
    expect(source).not.toMatch(/runs-on:\s*self-hosted\s*$/m);
  });
});
