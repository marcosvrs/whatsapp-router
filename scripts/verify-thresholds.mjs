import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const full = args.includes("--full");
const staged = args.includes("--staged");
const coverageOnly = args.includes("--coverage-only");
const mutationOnly = args.includes("--mutation-only");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;

if (coverageOnly && mutationOnly) {
  console.error("--coverage-only cannot be combined with --mutation-only");
  process.exit(2);
}
if (full && (staged || base)) {
  console.error("--full cannot be combined with --staged or --base");
  process.exit(2);
}
if (staged && base) {
  console.error("--staged cannot be combined with --base");
  process.exit(2);
}
if (baseIndex >= 0 && !base) {
  console.error("--base requires a revision");
  process.exit(2);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function diffArgs(extraArgs) {
  const diffArgs = ["diff", ...extraArgs, "--diff-filter=ACMRTUXBD"];
  if (staged) {
    diffArgs.splice(1, 0, "--cached");
  } else if (base) {
    diffArgs.push(base, "HEAD");
  } else {
    console.error("changed threshold verification requires --staged or --base <revision>");
    process.exit(2);
  }
  return diffArgs;
}

function changedFiles() {
  return execFileSync("git", diffArgs(["--name-only"]), { encoding: "utf8" })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function changedMutationRanges() {
  const patch = execFileSync("git", diffArgs(["--unified=0"]), { encoding: "utf8" });
  const ranges = new Map();
  let oldFile;
  let currentFile;
  let deletedSource = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("--- a/")) {
      oldFile = line.slice(6);
      continue;
    }
    if (line === "+++ /dev/null") {
      deletedSource ||= isSourceFile(oldFile ?? "");
      currentFile = undefined;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    if (!currentFile || !line.startsWith("@@ ")) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match || !isSourceFile(currentFile)) continue;
    const start = Number(match[1]);
    const count = Number(match[2] ?? "1");
    if (count === 0) {
      deletedSource = true;
      continue;
    }
    const fileRanges = ranges.get(currentFile) ?? [];
    fileRanges.push({ start, end: start + count - 1 });
    ranges.set(currentFile, fileRanges);
  }

  const mergedRanges = [];
  for (const [file, fileRanges] of ranges) {
    fileRanges.sort((left, right) => left.start - right.start);
    let current = fileRanges[0];
    for (const next of fileRanges.slice(1)) {
      if (next.start <= current.end + 1) {
        current.end = Math.max(current.end, next.end);
      } else {
        mergedRanges.push(`${file}:${current.start}-${current.end}`);
        current = next;
      }
    }
    if (current) mergedRanges.push(`${file}:${current.start}-${current.end}`);
  }
  return { ranges: mergedRanges, deletedSource };
}

function isSourceFile(file) {
  return file.startsWith("src/") && file.endsWith(".ts");
}

function requiresFullVerification(file) {
  return (
    file === "package.json" ||
    file === "package-lock.json" ||
    file === ".npmrc" ||
    file === "vitest.config.ts" ||
    file === "stryker.config.mjs" ||
    file === "src/index.ts" ||
    file.startsWith("tsconfig")
  );
}

function runCoverage(sourceFiles) {
  if (!sourceFiles) {
    run("npm", ["run", "test:coverage"]);
    return;
  }

  const coverageArgs = [
    "exec",
    "--offline",
    "--",
    "vitest",
    "related",
    "--run",
    "--coverage",
    "--coverage.exclude=src/index.ts",
  ];
  for (const file of sourceFiles) coverageArgs.push(`--coverage.include=${file}`);
  coverageArgs.push(...sourceFiles);
  run("npm", coverageArgs);
}

function runMutation(mutationRanges) {
  if (!mutationRanges) {
    run("npm", ["run", "test:mutation"]);
    return;
  }
  if (mutationRanges.length === 0) {
    console.log("No changed executable mutation targets; mutation checks are not required.");
    return;
  }

  run("npm", [
    "exec",
    "--offline",
    "--",
    "stryker",
    "run",
    `--mutate=${mutationRanges.join(",")}`,
  ]);
}

function runSelected(sourceFiles, mutationRanges) {
  if (!mutationOnly) runCoverage(sourceFiles);
  if (!coverageOnly) runMutation(mutationRanges);
}

if (full) {
  runSelected(undefined, undefined);
  process.exit(0);
}

const changed = changedFiles();
const sourceChanges = changed.filter(isSourceFile);
const testChanges = changed.some((file) => file.startsWith("test/"));
const { ranges: mutationRanges, deletedSource } = changedMutationRanges();
const forceFull = deletedSource || changed.some(requiresFullVerification);

if (forceFull) {
  runSelected(undefined, undefined);
  process.exit(0);
}

const sourceFiles = sourceChanges.filter((file) => existsSync(file) && file !== "src/index.ts");
if (sourceFiles.length === 0) {
  if (testChanges) {
    runSelected(undefined, undefined);
  } else {
    console.log("No changed production TypeScript files; threshold checks are not required.");
  }
  process.exit(0);
}

runSelected(sourceFiles, mutationRanges);
