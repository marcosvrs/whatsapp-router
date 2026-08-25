import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/build-and-push-image.yaml", import.meta.url),
  "utf8",
);

describe("image publishing workflow", () => {
  it("only publishes workflow-run images from successful pushes to main", () => {
    expect(workflow).toMatch(
      /github\.event_name == 'workflow_run'[\s\S]*github\.event\.workflow_run\.event == 'push'[\s\S]*github\.event\.workflow_run\.head_branch == 'main'/,
    );
  });
});
