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

function runMutation(sourceFiles) {
  if (!sourceFiles) {
    run("npm", ["run", "test:mutation"]);
    return;
  }

  run("npm", [
    "exec",
    "--offline",
    "--",
    "stryker",
    "run",
    `--mutate=${sourceFiles.join(",")}`,
  ]);
}

function runSelected(sourceFiles) {
  if (!mutationOnly) runCoverage(sourceFiles);
  if (!coverageOnly) runMutation(sourceFiles);
}

function changedFiles() {
  const diffArgs = ["diff", "--name-only", "--diff-filter=ACMRTUXBD"];
  if (staged) {
    diffArgs.splice(1, 0, "--cached");
  } else if (base) {
    diffArgs.push(base, "HEAD");
  } else {
    console.error("changed threshold verification requires --staged or --base <revision>");
    process.exit(2);
  }
  return execFileSync("git", diffArgs, { encoding: "utf8" })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
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
    file.startsWith("tsconfig") ||
    file.startsWith("scripts/") ||
    file.startsWith(".githooks/") ||
    file.startsWith(".github/workflows/")
  );
}

if (full) {
  runSelected(undefined);
  process.exit(0);
}

const changed = changedFiles();
const sourceChanges = changed.filter(isSourceFile);
const deletedSource = sourceChanges.some((file) => !existsSync(file));
const forceFull = deletedSource || changed.some(requiresFullVerification);

if (forceFull) {
  runSelected(undefined);
  process.exit(0);
}

const sourceFiles = sourceChanges.filter((file) => existsSync(file) && file !== "src/index.ts");
if (sourceFiles.length === 0) {
  console.log("No changed production TypeScript files; threshold checks are not required.");
  process.exit(0);
}

runSelected(sourceFiles);
