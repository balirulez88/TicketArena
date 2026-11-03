#!/usr/bin/env node
//
// RED evidence for ralph-loop.sh. A failing suite alone does not prove RED: a test file that no
// workspace package runs, that the package's Vitest `include` does not match, that fails to load,
// or whose tests are all skipped executes nothing, and the suite can then fail (or pass) for an
// unrelated reason. This script runs exactly the changed test files, uncached, through each owning
// package's own Vitest and accepts RED only when every one of them executed at least one test and
// at least one of those tests failed (an assertion or an error thrown inside the test, such as a
// call to a function that does not exist yet; never a file that failed to load).
//
//   node scripts/ralph-red.mjs [--root <dir>] [--runner <command>] --out <dir> <test file>...
//
// --runner runs Vitest inside one package (default: `pnpm exec vitest`); it is split on spaces,
// so its words must not contain spaces. --out is emptied first: evidence is only ever this run's.
//
// Exit codes: 0 RED proven, 1 not proven (reasons on stdout).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// A hung or watching test run must not hang the harness.
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

// Paths in Vitest's report are absolute and real (symlinks resolved), with forward slashes; on
// Windows the drive letter's case varies too. Comparison happens on this form only.
const normalize = (path) => {
  let absolute = resolve(path);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // A file that does not exist cannot match a report entry either way.
  }
  const slashed = absolute.split(sep).join("/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};

// `packages/*`-style globs from pnpm-workspace.yaml; `*` matches one path segment. That is the
// only form this repository uses; `**` and negations are not supported.
export function workspaceGlobs(text) {
  const section = /^packages:\s*\n((?:\s+-\s+.+\n?)*)/m.exec(text)?.[1] ?? "";
  return [...section.matchAll(/-\s+["']?([^"'\n]+?)["']?\s*$/gm)].map((match) => match[1]);
}

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+")}$`,
  );
// The nearest directory with a package.json below the root, or null for a file no package owns.
export function owningPackage(file, { root, exists }) {
  let dir = dirname(resolve(root, file));
  const top = resolve(root);
  while (dir.startsWith(top) && dir !== top) {
    if (exists(join(dir, "package.json"))) {
      return relative(top, dir).split(sep).join("/");
    }
    dir = dirname(dir);
  }
  return null;
}

// Groups the files by owning package; a file no workspace package with a `test` script owns is
// never discovered by `pnpm run test`, which is an error, not a skip.
export function planRun(files, { root, exists, readText }) {
  const globs = workspaceGlobs(readText(join(root, "pnpm-workspace.yaml"))).map(globToRegExp);
  const groups = new Map();
  const errors = [];
  for (const file of files) {
    const pkg = owningPackage(file, { root, exists });
    if (pkg === null || !globs.some((glob) => glob.test(pkg))) {
      errors.push(`${file} is not inside a workspace package, so no test run discovers it`);
      continue;
    }
    const manifest = JSON.parse(readText(join(root, pkg, "package.json")));
    if (typeof manifest.scripts?.test !== "string") {
      errors.push(`${file} belongs to ${pkg}, which has no "test" script, so it never runs`);
      continue;
    }
    groups.set(pkg, [...(groups.get(pkg) ?? []), file]);
  }
  return { groups, errors };
}

const EXECUTED = new Set(["passed", "failed"]);

// The reason one file proves nothing, or null when at least one of its tests executed.
function notExecuted(file, result) {
  if (!result) {
    return `${file} was not executed: its package's test runner does not match it`;
  }
  const assertions = result.assertionResults ?? [];
  if (assertions.length === 0 && result.status === "failed") {
    const reason = String(result.message ?? "").split("\n")[0];
    return `${file} failed to load, so none of its tests ran: ${reason}`;
  }
  if (!assertions.some((assertion) => EXECUTED.has(assertion.status))) {
    return `${file} executed no test (all skipped, todo or empty)`;
  }
  return null;
}

// Judges Vitest JSON reports (one per package; null when the run wrote none) against the files.
export function evaluate(files, reports, { root }) {
  const results = new Map(
    reports.flatMap((report) => report?.testResults ?? []).map((r) => [normalize(r.name), r]),
  );
  const errors = [];
  const failed = [];
  for (const file of files) {
    const result = results.get(normalize(resolve(root, file)));
    const error = notExecuted(file, result);
    if (error) {
      errors.push(error);
      continue;
    }
    for (const assertion of result.assertionResults.filter((a) => a.status === "failed")) {
      failed.push(`${file} > ${assertion.fullName}`);
    }
  }
  if (files.length > 0 && errors.length === 0 && failed.length === 0) {
    errors.push("every new test ran and passed, so none of them proves a missing behaviour");
  }
  return { ok: errors.length === 0, errors, failed };
}

function runPackage({ root, runner, out }, pkg, files, index) {
  const cwd = join(root, pkg);
  const outFile = join(out, `red-${index}.json`);
  const [command, ...prefix] = runner.split(" ").filter(Boolean);
  const args = [...prefix, "run", "--reporter=json", `--outputFile=${outFile}`];
  // Vitest filters by path with forward slashes on every platform.
  const filters = files.map((file) => relative(cwd, join(root, file)).split(sep).join("/"));
  // Exit status is irrelevant: a RED run fails by design; the report is the evidence. The output
  // is kept so a missing report can be diagnosed.
  const run = spawnSync(command, [...args, ...filters], {
    cwd,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    shell: process.platform === "win32",
  });
  writeFileSync(
    join(out, `red-${index}.log`),
    `${[command, ...args, ...filters].join(" ")}\n${run.error ?? ""}\n${run.stdout ?? ""}${run.stderr ?? ""}`,
  );
  return existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      runner: { type: "string", default: "pnpm exec vitest" },
      out: { type: "string" },
    },
  });
  if (!values.out || positionals.length === 0) {
    process.stderr.write(
      "usage: ralph-red.mjs [--root <dir>] [--runner <cmd>] --out <dir> <test>...\n",
    );
    process.exit(2);
  }
  const root = resolve(values.root);
  const out = resolve(values.out);
  // An earlier attempt's report must never stand in for this run's.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const io = { root, exists: existsSync, readText: (path) => readFileSync(path, "utf8") };
  const { groups, errors } = planRun(positionals, io);
  const reports = [...groups].map(([pkg, files], index) =>
    runPackage({ root, runner: values.runner, out }, pkg, files, index),
  );
  const verdict = evaluate([...groups.values()].flat(), reports, { root });
  for (const line of verdict.failed) {
    process.stdout.write(`failing as expected: ${line}\n`);
  }
  const problems = [...errors, ...verdict.errors];
  for (const problem of problems) {
    process.stdout.write(`RED rejected: ${problem}\n`);
  }
  process.exit(problems.length === 0 && verdict.ok && reports.length > 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
