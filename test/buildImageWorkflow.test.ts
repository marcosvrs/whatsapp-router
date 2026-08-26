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
  it("requires every trusted check to pass for the exact image commit", () => {
    for (const required of ["lint-build-test", "mutation", "npm-audit", "socket-security"]) {
      expect(workflow).toContain(`.name == $name and .head_sha == $sha and .conclusion == "success"`);
      expect(workflow).toContain(required);
    }
    expect(workflow).toContain("github.event.workflow_run.head_sha");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
  });
  it("sets up a non-docker Buildx driver before exporting the GHA cache", () => {
    expect(workflow).toContain("docker/setup-buildx-action@");
    expect(workflow).toMatch(/setup-buildx-action@[\da-f]{40}/);
  });
});
