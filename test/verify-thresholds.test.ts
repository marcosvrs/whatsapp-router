import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../scripts/verify-thresholds.mjs", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatsapp-router-thresholds-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("verify-thresholds", () => {
  it("runs full mutation verification for a deletion-only source hunk", () => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const fakeGit = join(binDir, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
case " $* " in
  *" --name-only "*) printf '%s\\n' 'src/router.ts' ;;
  *) printf '%s\\n' 'diff --git a/src/router.ts b/src/router.ts' '--- a/src/router.ts' '+++ b/src/router.ts' '@@ -10 +10,0 @@' '-removed' ;;
esac
`,
    );
    const fakeNpm = join(binDir, "npm");
    writeFileSync(fakeNpm, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$THRESHOLD_TEST_OUTPUT"\n');
    chmodSync(fakeGit, 0o755);
    chmodSync(fakeNpm, 0o755);
    const outputPath = join(dir, "npm-args.txt");
    const result = spawnSync(process.execPath, [scriptPath, "--mutation-only", "--staged"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        THRESHOLD_TEST_OUTPUT: outputPath,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("run test:mutation");
  });
  it("runs full verification when production and test files both change", () => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const fakeGit = join(binDir, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
case " $* " in
  *" --name-only "*) printf '%s\\n' 'src/router.ts' 'test/router.test.ts' ;;
  *) printf '%s\\n' 'diff --git a/src/router.ts b/src/router.ts' '--- a/src/router.ts' '+++ b/src/router.ts' '@@ -10 +10 @@' '+changed' ;;
esac
`,
    );
    const fakeNpm = join(binDir, "npm");
    writeFileSync(fakeNpm, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$THRESHOLD_TEST_OUTPUT"\n');
    chmodSync(fakeGit, 0o755);
    chmodSync(fakeNpm, 0o755);
    const outputPath = join(dir, "npm-args.txt");
    const result = spawnSync(process.execPath, [scriptPath, "--mutation-only", "--staged"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        THRESHOLD_TEST_OUTPUT: outputPath,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("run test:mutation");
  });
});
