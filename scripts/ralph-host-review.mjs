#!/usr/bin/env node
//
// The host's own independent review of a candidate slice (ADR 0015). ralph-accept.mjs calls it
// after the slice passed the path rules and the hardened gate, and before anything reaches the
// base branch. The Standards and Spec reviews that ran inside the agent's sandbox drive the fix
// loop there, but they shared a container, a user and a file system with the agent, so the host
// takes nothing from them. Here:
//
//   - The changeset, its token, the prompts and the schema are made by the host, from its own Git
//     and its own copy of the harness (scripts/ralph-review-prompt.mjs).
//   - Each reviewer is a fresh session in its own disposable container (sandbox-entrypoint.sh
//     --review): a read-only snapshot of exactly the candidate commit, no output mount, no host
//     repository, no Docker socket, a read-only root file system, all capabilities dropped, and
//     a timeout. Its report is what it prints; the host reads it from the container's stdout.
//   - The host judges both reports with the review gate (scripts/ralph-review.mjs) against the
//     candidate's real changeset, commit range, token, ticket and register, resolving test
//     references in the candidate's tree. An invalid report is asked for once more, with the
//     gate's reasons, in a new container, as the loop does. Both axes must approve.
//
// Environment: RALPH_IMAGE (default ticketarena-sandbox), RALPH_REVIEW_BLOCKING (default
// CRITICAL,HIGH), RALPH_REVIEW_TIMEOUT (seconds, default 1800), RALPH_REVIEW_CMD (passed to the
// reviewer container, for stub reviewers in tests), RALPH_PROVIDER_RETRIES (default 2) and
// RALPH_PROVIDER_BACKOFF (seconds, default 60) for transient provider failures. RALPH_HOST_REVIEWER
// replaces the container with a command (tests): it gets the input directory as its last argument
// and prints the reviewer's output.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./ralph-provider.mjs";
import {
  annotateChangeset,
  debtContext,
  evaluate,
  parseBlocking,
  parseChangeset,
  parseCriteria,
} from "./ralph-review.mjs";
import { reviewPrompt } from "./ralph-review-prompt.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const IMAGE = env.RALPH_IMAGE || "ticketarena-sandbox";
const TIMEOUT = Number(env.RALPH_REVIEW_TIMEOUT || 1800);
const RETRIES = Number(env.RALPH_PROVIDER_RETRIES ?? 2);
const BACKOFF = Number(env.RALPH_PROVIDER_BACKOFF ?? 60);
const REGISTER = "docs/technical-debt.md";
const SCHEMA = join(root, "skills", "code-review", "report.schema.json");
// Where the reviewer finds the changeset, inside its own (git-ignored) workspace.
const CHANGESET_DIR = ".ralph/review/host";
const MAX_OUTPUT = 32 * 1024 * 1024;
const AXES = ["standards", "spec"];

const log = (message) => console.error(`[ralph-host-review] ${message}`);
const sleep = (seconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

function git(args, options = {}) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
    ...options,
  });
}
function gitOut(...args) {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.replace(/\n$/, "");
}
const lines = (text) => text.split("\n").filter(Boolean);

/** Runs one reviewer and returns { stdout, stderr, status }. */
function runReviewer(axis, inputDir, slice, name) {
  if (env.RALPH_HOST_REVIEWER) {
    const [command, ...args] = env.RALPH_HOST_REVIEWER.split(" ").filter(Boolean);
    const result = spawnSync(command, [...args, inputDir], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      timeout: TIMEOUT * 1000,
      env: { ...env, RALPH_REVIEW_AXIS: axis, RALPH_REVIEW_COMMIT: slice },
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  }
  // RALPH_HOST_REVIEW_CMD replaces `claude -p` inside the container (stub reviewers in the Docker
  // tests); RALPH_REVIEW_CMD stays the loop's own setting.
  const passed = [
    ...["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].flatMap((variable) =>
      env[variable] ? ["--env", variable] : [],
    ),
    ...(env.RALPH_HOST_REVIEW_CMD
      ? ["--env", `RALPH_REVIEW_CMD=${env.RALPH_HOST_REVIEW_CMD}`]
      : []),
  ];
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
      "--read-only",
      "--tmpfs",
      "/tmp:exec,mode=1777",
      "--tmpfs",
      "/home/node:exec,uid=1000,gid=1000",
      "--memory",
      "4g",
      "--pids-limit",
      "1024",
      "--mount",
      `type=bind,src=${inputDir},dst=/ralph-in,readonly`,
      "--env",
      `RALPH_REVIEW_COMMIT=${slice}`,
      "--env",
      `RALPH_REVIEW_TIMEOUT=${TIMEOUT}`,
      "--env",
      `RALPH_REVIEW_AXIS=${axis}`,
      ...passed,
      IMAGE,
      "--review",
    ],
    {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      timeout: (TIMEOUT + 120) * 1000,
      killSignal: "SIGKILL",
      env: { ...env, MSYS_NO_PATHCONV: "1" },
    },
  );
  if (result.error) {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/**
 * The host review of `slice` (the squashed slice commit, whose parent is `base`).
 * Returns { verdict: "approved" | "blocked" | "invalid" | "unavailable", decision, reason }.
 */
export function hostReview({ base, slice, ticket, logDir, workDir, label }) {
  mkdirSync(logDir, { recursive: true });
  const raw = gitOut("diff", "--no-ext-diff", "--no-textconv", `${base}...${slice}`);
  const token = randomBytes(8).toString("hex");
  const changesetText = `${annotateChangeset(`${raw}\n`)}\n\nreview-token: ${token}\n`;
  writeFileSync(join(logDir, "changeset.diff"), changesetText);
  const ticketText = gitOut("show", `${slice}:${ticket}`);
  const slug = ticket.replace(/^.*\//, "").replace(/\.md$/, "");
  const changeset = `${CHANGESET_DIR}/${slug}.diff`;
  const prompt = (axis, rejected) =>
    reviewPrompt({
      axis,
      ticket,
      ticketText,
      changeset,
      base,
      head: slice,
      range: `${base}...${slice}`,
      changedFiles: lines(gitOut("diff", "--name-only", `${base}...${slice}`)),
      commits: lines(gitOut("log", "--oneline", `${base}..${slice}`)),
      register: REGISTER,
      rejected,
    });
  // A bundle carries refs, not bare commits: name the candidate under a private ref only for that.
  const ref = `refs/ralph/review/${label}`;
  gitOut("update-ref", ref, slice);
  const bundle = join(workDir, "repo.bundle");
  mkdirSync(workDir, { recursive: true });
  try {
    gitOut("bundle", "create", "--quiet", bundle, ref);
  } finally {
    git(["update-ref", "-d", ref]);
  }

  let unavailable = null;
  const review = (axis, rejected) => {
    const inputDir = join(workDir, axis);
    rmSync(inputDir, { recursive: true, force: true });
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(join(inputDir, "changeset.diff"), changesetText);
    writeFileSync(join(inputDir, "changeset.path"), changeset);
    writeFileSync(join(inputDir, "prompt.txt"), prompt(axis, rejected));
    writeFileSync(join(inputDir, "schema.json"), readFileSync(SCHEMA, "utf8"));
    writeFileSync(join(inputDir, "repo.bundle"), readFileSync(bundle));
    for (let attempt = 0; ; attempt++) {
      log(`${axis} reviewer: a fresh session in an isolated container`);
      const result = runReviewer(axis, inputDir, slice, `ralph-review-${label}-${axis}-${attempt}`);
      writeFileSync(join(logDir, `${axis}.json`), result.stdout);
      writeFileSync(join(logDir, `${axis}.stderr.log`), result.stderr);
      const kind =
        result.status === 0
          ? "none"
          : classify({ exitCode: result.status, output: `${result.stdout}\n${result.stderr}` });
      if (kind === "none") {
        return result.stdout;
      }
      if (kind !== "transient" || attempt >= RETRIES) {
        unavailable = `the ${axis} reviewer was cut off by the provider (${kind})`;
        return "";
      }
      log(`${axis} reviewer: transient provider failure; retrying in ${BACKOFF * 2 ** attempt}s`);
      sleep(BACKOFF * 2 ** attempt);
    }
  };

  const registerText = gitOut("show", `${slice}:${REGISTER}`);
  const judge = (outputs) =>
    evaluate({
      standardsOutput: outputs.standards,
      specOutput: outputs.spec,
      blocking: parseBlocking(env.RALPH_REVIEW_BLOCKING || "CRITICAL,HIGH"),
      context: {
        base,
        head: slice,
        token,
        files: parseChangeset(changesetText).files,
        criteria: parseCriteria(ticketText),
        ...debtContext(registerText),
        // Test references must exist in the candidate itself, not in the host's checkout.
        pathExists: (path) =>
          path.length > 0 &&
          !isAbsolute(path) &&
          !path.split(/[\\/]/).includes("..") &&
          git(["cat-file", "-e", `${slice}:${path.replace(/\\/g, "/").replace(/^\.\//, "")}`])
            .status === 0,
      },
    });

  try {
    const outputs = {};
    for (const axis of AXES) {
      outputs[axis] = review(axis);
      if (unavailable) {
        return { verdict: "unavailable", reason: unavailable };
      }
    }
    let result = judge(outputs);
    const invalid = AXES.filter((axis) => (result.decision.errors?.[axis] ?? []).length > 0);
    if (result.verdict === "invalid" && invalid.length > 0) {
      for (const axis of invalid) {
        log(`the ${axis} report is invalid; asking that reviewer once more`);
        writeFileSync(join(logDir, `${axis}.invalid.json`), outputs[axis]);
        const reasons = result.decision.errors[axis].map((error) => `- ${error}`).join("\n");
        outputs[axis] = review(axis, reasons);
        if (unavailable) {
          return { verdict: "unavailable", reason: unavailable };
        }
      }
      result = judge(outputs);
    }
    writeFileSync(join(logDir, "review.md"), `${result.report}\n`);
    writeFileSync(join(logDir, "decision.json"), `${JSON.stringify(result.decision, null, 2)}\n`);
    log(
      `host review of ${slice.slice(0, 12)}: ${result.verdict} (report: ${join(logDir, "review.md")})`,
    );
    return { verdict: result.verdict, decision: result.decision, reason: result.verdict };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
