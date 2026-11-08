#!/usr/bin/env node
//
// The host's own quality gate on a candidate commit (ADR 0015), run before ralph-accept.mjs lets
// a slice reach the base branch:
//
//   node scripts/ralph-verify.mjs <commit>        (scripts/sandbox.sh --verify builds the image)
//   node scripts/ralph-verify.mjs --red <commit> <test file>...
//
// The second form is the RED proof of scripts/ralph-replay.mjs: <commit> holds the base plus only
// the candidate's test files, and the same prepared, offline, read-only test container runs lint
// and then exactly those files through scripts/ralph-red.mjs. Exit 0 only if RED is proven.
//
// The candidate's tests and package code were written by the agent, so they are executed as
// untrusted code, never inside a process whose word the host takes. Every stage is a disposable
// container from the sandbox image (scripts/sandbox-entrypoint.sh), with all capabilities dropped,
// no privilege escalation, memory, CPU and process limits, a timeout this script enforces, and no
// host mount but the read-only input (a bundle holding the candidate). The stages share one Docker
// volume, the prepared workspace:
//
//   prepare   network on, to fetch packages: checks the debt register, then installs the locked
//             dependencies and generates the database client. Only trusted code runs here: the
//             importer refuses slices that change install scripts, build-script packages, the
//             toolchain's locked closure or Prisma generators.
//   tools     no network: the register check, lint, typecheck and the harness tests. Biome, tsc,
//             Turbo and the harness read the slice's code as data and execute none of it.
//   test      no network, read-only root file system and read-only workspace, one container per
//             workspace package (and the root `test` script when it is not `turbo run test`).
//             This is where the slice's code runs: it can write nothing that another package's
//             run, a later stage or the host reads, and Yama keeps it from tracing the runner.
//
// The verdict is each container's exit status as Docker reports it, and nothing else: no file,
// log or output of any stage is read. Exit 0 only if every stage passed.
//
// Environment: RALPH_IMAGE (default ticketarena-sandbox), RALPH_VERIFY_TIMEOUT (seconds per
// container, default 1800), RALPH_VERIFY_MEMORY (default 6g), RALPH_VERIFY_CPUS (default 4),
// RALPH_VERIFY_PIDS (default 4096).

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const IMAGE = env.RALPH_IMAGE || "ticketarena-sandbox";
const TIMEOUT = Number(env.RALPH_VERIFY_TIMEOUT || 1800);
const LIMITS = [
  "--memory",
  env.RALPH_VERIFY_MEMORY || "6g",
  "--memory-swap",
  env.RALPH_VERIFY_MEMORY || "6g",
  "--cpus",
  env.RALPH_VERIFY_CPUS || "4",
  "--pids-limit",
  env.RALPH_VERIFY_PIDS || "4096",
];
const WORKSPACE = "/workspace";

const log = (message) => console.error(`[ralph-verify] ${message}`);

function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.replace(/\n$/, "");
}
const show = (sha, path) => {
  const result = spawnSync("git", ["-C", root, "show", `${sha}:${path}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

/**
 * The directories whose `test` script the gate runs, read from the candidate as data: the
 * workspace packages (pnpm-workspace.yaml is protected, so its globs are the base's), plus "." when
 * the root `test` script does something other than fan out to them through Turbo.
 */
export function testTargets(sha) {
  const scriptOf = (path) => {
    try {
      const script = JSON.parse(show(sha, path) ?? "null")?.scripts?.test;
      return typeof script === "string" && script.trim() !== "" ? script.trim() : null;
    } catch {
      return null;
    }
  };
  const globs = parse(show(sha, "pnpm-workspace.yaml") ?? "")?.packages ?? [];
  const targets = [];
  for (const glob of globs) {
    // Only the `group/*` form is understood; anything else must not silently drop packages.
    const match = /^([A-Za-z0-9._-]+)\/\*$/.exec(String(glob));
    if (!match) {
      throw new Error(`pnpm-workspace.yaml: unsupported package glob ${JSON.stringify(glob)}`);
    }
    const listing = git("ls-tree", "--name-only", "-z", sha, `${match[1]}/`);
    for (const dir of listing.split("\0").filter(Boolean)) {
      if (scriptOf(`${dir}/package.json`) !== null && !targets.includes(dir)) {
        targets.push(dir);
      }
    }
  }
  const rootScript = scriptOf("package.json");
  if (rootScript !== null && rootScript !== "turbo run test") {
    targets.push(".");
  }
  return targets;
}

/** Runs one container to completion, killed at the timeout; returns its exit status. */
function container(name, options, args) {
  log(`${name}: starting`);
  const started = Date.now();
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...LIMITS,
      ...options,
      IMAGE,
      ...args,
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: TIMEOUT * 1000,
      killSignal: "SIGKILL",
      env: { ...env, MSYS_NO_PATHCONV: "1" },
    },
  );
  if (result.error) {
    spawnSync("docker", ["kill", name], { stdio: "ignore" });
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
    log(
      `${name}: ${result.error.message.includes("ETIMEDOUT") ? `timed out after ${TIMEOUT}s` : result.error.message}`,
    );
    return 1;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  log(
    `${name}: ${result.status === 0 ? "passed" : `FAILED (exit ${result.status})`} in ${seconds}s`,
  );
  return result.status ?? 1;
}

/**
 * Prepares a workspace volume at `commit` (a bundle of just that commit, the dependencies
 * installed with only trusted code running) and hands `run` the helpers for its offline stages.
 * The volume and the run directory are gone afterwards. `run` returns the exit status.
 */
function withWorkspace(commit, describe, run) {
  const sha = git("rev-parse", "--verify", `${commit}^{commit}`);
  const id = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${process.pid}`;
  const runDir = join(root, ".ralph", "sandbox", `verify-${id}`);
  const volume = `ralph-verify-${id}`;
  const prefix = `ralph-verify-${id}`;
  mkdirSync(join(runDir, "in"), { recursive: true });
  // A bundle carries refs, not bare commits: name the commit under a private ref only for that.
  git("update-ref", `refs/ralph/verify/${id}`, sha);
  try {
    git(
      "bundle",
      "create",
      "--quiet",
      join(runDir, "in", "repo.bundle"),
      `refs/ralph/verify/${id}`,
    );
  } finally {
    git("update-ref", "-d", `refs/ralph/verify/${id}`);
  }
  const input = ["--mount", `type=bind,src=${join(runDir, "in")},dst=/ralph-in,readonly`];
  const shared = (mode) => ["--mount", `type=volume,src=${volume},dst=${WORKSPACE}${mode}`];
  const offline = [
    "--network",
    "none",
    "--tmpfs",
    "/tmp:exec,mode=1777",
    "--tmpfs",
    "/home/node:exec,uid=1000,gid=1000",
  ];
  if (spawnSync("docker", ["volume", "create", volume], { stdio: "ignore" }).status !== 0) {
    throw new Error(`could not create the Docker volume ${volume}`);
  }
  try {
    log(`${describe(sha)}: prepare first`);
    const prepared = container(
      `${prefix}-prepare`,
      [...input, ...shared(""), "--env", `RALPH_VERIFY_COMMIT=${sha}`],
      ["--prepare"],
    );
    if (prepared !== 0) {
      return 1;
    }
    return run({ sha, prefix, offline, shared });
  } finally {
    spawnSync("docker", ["volume", "rm", "--force", volume], { stdio: "ignore" });
    rmSync(runDir, { recursive: true, force: true });
  }
}

// The test stages see the prepared workspace read-only; Vite's temp directory is their one
// writable path in a package.
const tempDir = (target) =>
  `${WORKSPACE}/${target === "." ? "" : `${target}/`}node_modules/.vite-temp`;
const testMounts = (offline, shared, ...targets) => [
  ...offline,
  "--read-only",
  ...targets.flatMap((target) => ["--tmpfs", `${tempDir(target)}:exec,uid=1000,gid=1000`]),
  ...shared(",readonly"),
];

export function verify(commit) {
  const sha = git("rev-parse", "--verify", `${commit}^{commit}`);
  const targets = testTargets(sha);
  return withWorkspace(
    sha,
    (full) =>
      `verifying ${full.slice(0, 12)}: prepare, tools, then tests in ${targets.join(", ") || "no package"}`,
    ({ prefix, offline, shared }) => {
      if (container(`${prefix}-tools`, [...offline, ...shared("")], ["--tools"]) !== 0) {
        return 1;
      }
      let failed = 0;
      for (const [index, target] of targets.entries()) {
        const status = container(`${prefix}-test-${index}`, testMounts(offline, shared, target), [
          "--test",
          target,
        ]);
        failed += status === 0 ? 0 : 1;
      }
      log(
        failed === 0
          ? `${sha.slice(0, 12)}: the gate passed`
          : `${sha.slice(0, 12)}: ${failed} test stage(s) FAILED`,
      );
      return failed === 0 ? 0 : 1;
    },
  );
}

/**
 * RED for a replayed candidate: `commit` is the base plus only the candidate's test files. Every
 * test file must execute and at least one test must fail (scripts/ralph-red.mjs), after lint.
 * The tests run exactly as the gate's tests do: offline, read-only, in a disposable container.
 */
export function proveRed(commit, tests) {
  if (tests.length === 0) {
    throw new Error("RED needs at least one test file");
  }
  return withWorkspace(
    commit,
    (full) => `proving RED of ${tests.length} test file(s) on ${full.slice(0, 12)}`,
    ({ sha, prefix, offline, shared }) => {
      // Vitest bundles each package's config into that package's temp directory, so every package
      // that can own one of the files gets its one writable path.
      const status = container(
        `${prefix}-red`,
        [
          ...(env.RALPH_RED_RUNNER ? ["--env", `RALPH_RED_RUNNER=${env.RALPH_RED_RUNNER}`] : []),
          ...testMounts(offline, shared, ...new Set([".", ...testTargets(sha)])),
        ],
        ["--red", ...tests],
      );
      log(`${sha.slice(0, 12)}: RED ${status === 0 ? "proven" : "NOT proven"}`);
      return status;
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [first, ...rest] = process.argv.slice(2);
    if (first === "--red") {
      const [commit, ...tests] = rest;
      if (!commit || tests.length === 0) {
        throw new Error("usage: ralph-verify.mjs --red <commit> <test file>...");
      }
      process.exitCode = proveRed(commit, tests);
    } else if (first && first !== "--red") {
      process.exitCode = verify(first);
    } else {
      throw new Error("usage: ralph-verify.mjs <commit> | --red <commit> <test file>...");
    }
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
