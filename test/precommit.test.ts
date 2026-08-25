import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-precommit-test-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(dir, ".githooks"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, ".githooks/pre-commit"), readFileSync(fileURLToPath(new URL("../.githooks/pre-commit", import.meta.url))));
  writeFileSync(join(dir, "src/app.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "initial");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pre-commit staged snapshot", () => {
  it("does not expose unstaged files to threshold checks", () => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const resultPath = join(dir, "hook-result.txt");
    writeFileSync(
      join(binDir, "npm"),
      `#!/bin/sh
if [ "$1" = "run" ]; then
  if [ -e test/unstaged-marker.txt ]; then
    printf '%s\\n' marker-present > "$HOOK_RESULT"
    exit 1
  fi
  printf '%s\\n' "$PWD" > "$HOOK_RESULT"
fi
`,
    );
    writeFileSync(join(binDir, "gitleaks"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "npm"), 0o755);
    chmodSync(join(binDir, "gitleaks"), 0o755);

    writeFileSync(join(dir, "src/app.ts"), "export const value = 2;\n");
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test/unstaged-marker.txt"), "must stay outside snapshot\n");
    git("add", "src/app.ts");

    const result = spawnSync("sh", [".githooks/pre-commit"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_INDEX_FILE: ".git/index",
        HOOK_RESULT: resultPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const checkedDirectory = readFileSync(resultPath, "utf8").trim();
    expect(checkedDirectory).not.toBe(dir);
    expect(readFileSync(join(dir, "test/unstaged-marker.txt"), "utf8")).toContain("outside snapshot");
  });
});
