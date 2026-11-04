#!/usr/bin/env node
//
// Bounded autonomous batches of Ralph tickets, on the HOST:
//
//   pnpm sandbox --max-tickets N        (scripts/sandbox.sh hands --max-tickets to this script)
//   node scripts/ralph-batch.mjs --max-tickets N | --status | --new --max-tickets N
//
// One ticket at a time, each in its own sandbox run (`--ticket NN`, so every gate of
// ralph-loop.sh applies), then: push the base branch to GitHub, wait for CI on exactly that
// commit, and only then pick the next eligible ticket. The container never sees GitHub
// credentials; that is why the batch lives out here and not in ralph-loop.sh.
//
// Every step is recorded in .ralph/batch/state.json before and after it runs, and the repository
// is the source of truth for merges: a ticket counts as merged only when the base branch has both
// its archived file (done) and its `Merge slice/<slug>:` commit. A rerun therefore resumes at the
// right checkpoint after any interruption (usage limit, kill, CI timeout) and never runs a merged
// ticket again. Anything ambiguous stops the batch until a rerun can verify it.
//
// Stops, with the reason reported:
//   batch-limit, no-eligible-ticket          finished                  exit 0
//   unresolved-dependency                    finished; tickets wait     exit 2
//   paused (ralph-loop exit 75)              resumable: rerun           exit 75
//   ambiguous-merge, runner-failed, push-failed, ci-unverified, base-not-verified
//                                            resumable: fix, rerun      exit 1
//   rejected, ci-failed                      final; `--new` starts over exit 1
//
// Environment (defaults are the real thing; tests inject stubs):
//   RALPH_BATCH_RUNNER  runs one ticket, `--ticket NN` appended (default: bash scripts/sandbox.sh)
//   RALPH_BATCH_CI      verifies CI for a commit, its sha appended; exit 0 passed, 1 failed,
//                       anything else unknown (default: bash scripts/ralph-ci.sh)
//   RALPH_BATCH_REMOTE  the remote CI runs on (default: origin)
//   RALPH_BASE_BRANCH   integration branch (default: main)
//   RALPH_BATCH_DIR     state and lock (default: .ralph/batch)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const BASE = env.RALPH_BASE_BRANCH ?? "main";
const REMOTE = env.RALPH_BATCH_REMOTE ?? "origin";
const RUNNER = env.RALPH_BATCH_RUNNER ?? "bash scripts/sandbox.sh";
const CI = env.RALPH_BATCH_CI ?? "bash scripts/ralph-ci.sh";
const DIR = resolve(root, env.RALPH_BATCH_DIR ?? ".ralph/batch");
const STATE = join(DIR, "state.json");
const LOCK = join(DIR, "lock");
const PAUSED_EXIT = 75;

// Stops a rerun can resume from; the others end the batch.
const RESUMABLE = new Set([
  "paused",
  "ambiguous-merge",
  "runner-failed",
  "push-failed",
  "ci-unverified",
  "base-not-verified",
]);
const EXIT = { "batch-limit": 0, "no-eligible-ticket": 0, "unresolved-dependency": 2, paused: 75 };

class Stop extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

const log = (message) => console.error(`[ralph-batch] ${message}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const git = (...args) => run("git", args);
const gitOut = (...args) => {
  const result = git(...args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};
// Commands from the environment are words separated by spaces, like RALPH_AGENT_CMD.
const words = (command) => command.split(" ").filter(Boolean);

// --- State ----------------------------------------------------------------------------------

function loadState() {
  if (!existsSync(STATE)) {
    return null;
  }
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  if (
    !(Number.isInteger(state.max_tickets) && state.max_tickets > 0 && Array.isArray(state.tickets))
  ) {
    throw new Error(`${STATE} is malformed; inspect it and move it away to start over`);
  }
  return state;
}

// Written whole and renamed into place, so an interruption leaves the old or the new state.
function saveState(state) {
  mkdirSync(DIR, { recursive: true });
  state.updated_at = new Date().toISOString();
  writeFileSync(`${STATE}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${STATE}.tmp`, STATE);
}

// --- Lock -----------------------------------------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// mkdir is atomic: exactly one process creates the lock. A lock left by a killed batch is never
// taken over automatically (pids are reused, hosts differ); a human removes it.
function acquireLock() {
  mkdirSync(DIR, { recursive: true });
  try {
    mkdirSync(LOCK);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    let owner = {};
    try {
      owner = JSON.parse(readFileSync(join(LOCK, "owner.json"), "utf8"));
    } catch {
      // Unknown owner: still locked.
    }
    const stale = owner.host === hostname() && Number.isInteger(owner.pid) && !alive(owner.pid);
    throw new Error(
      stale
        ? `${LOCK} was left by batch process ${owner.pid}, which is no longer running. If no batch is running, remove that directory and run again.`
        : `another Ralph batch is running (lock ${LOCK}, pid ${owner.pid ?? "unknown"} on ${owner.host ?? "unknown host"}).`,
    );
  }
  writeFileSync(
    join(LOCK, "owner.json"),
    JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() }),
  );
  const release = () => rmSync(LOCK, { recursive: true, force: true });
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      release();
      process.exit(code);
    });
  }
  return release;
}

// --- Repository facts -----------------------------------------------------------------------

const baseSha = () => gitOut("rev-parse", BASE);

function remoteSha() {
  const result = git("ls-remote", REMOTE, `refs/heads/${BASE}`);
  return result.status === 0 ? (result.stdout.split(/\s/)[0] ?? "") : "";
}

function preflight() {
  if (gitOut("symbolic-ref", "--short", "HEAD") !== BASE) {
    throw new Error(`the batch must start on '${BASE}'`);
  }
  if (gitOut("status", "--porcelain") !== "") {
    throw new Error("the working tree is not clean; the sandbox pushes into it");
  }
}

// merged: both marks on the base branch; absent: neither; anything else is ambiguous.
function mergeState(slug) {
  const archived = git("show", `${BASE}:issues/done/${slug}.md`);
  const done = archived.status === 0 && /^\*\*Status:\*\* done\s*$/m.test(archived.stdout);
  const merge = gitOut(
    "log",
    BASE,
    "--merges",
    "--fixed-strings",
    `--grep=Merge slice/${slug}:`,
    "--format=%H",
  );
  if (done && merge !== "") {
    return "merged";
  }
  return !done && merge === "" && archived.status !== 0 ? "absent" : "ambiguous";
}

// A rejection always leaves a new quarantine branch, even when the sandbox could not move the
// base branch and its blocked status went to a ralph/blocked-* side branch instead.
function rejectedRefs(slug) {
  return gitOut("for-each-ref", "--format=%(refname)", `refs/heads/rejected/${slug}-*`)
    .split("\n")
    .filter(Boolean);
}

function ticketStatus(slug) {
  const file = git("show", `${BASE}:issues/${slug}.md`);
  return /^\*\*Status:\*\* (.*)$/m.exec(file.stdout)?.[1]?.trim() ?? "";
}

// Ticket selection is ralph-loop.sh's own (next_ticket), never a second implementation of it.
function selectNext() {
  const script =
    'source ./ralph-loop.sh; if t="$(next_ticket)"; then echo "next $t"; else echo none; fi; waiting_tickets | sed "s/^/waiting /"';
  const result = run("bash", ["-c", script]);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const verdict = lines.find((line) => line === "none" || line.startsWith("next "));
  if (result.status !== 0 || verdict === undefined) {
    throw new Error(`could not select the next ticket: ${result.stderr.trim() || "no answer"}`);
  }
  const waiting = lines.filter((line) => line.startsWith("waiting ")).map((line) => line.slice(8));
  if (verdict === "none") {
    return { next: null, waiting };
  }
  const file = verdict.slice(5);
  const slug = file.replace(/^.*\//, "").replace(/\.md$/, "");
  return { next: { number: slug.slice(0, 2), slug }, waiting };
}

// --- Steps ----------------------------------------------------------------------------------

function verifyCi(sha) {
  log(`waiting for CI on ${sha.slice(0, 12)}`);
  const [command, ...args] = words(CI);
  const result = spawnSync(command, [...args, sha], { cwd: root, stdio: "inherit" });
  return result.status === 0 ? "passed" : result.status === 1 ? "failed" : "unknown";
}

// Nothing starts on a base that CI has not passed, whoever moved it.
function ensureBaseVerified(state) {
  const sha = baseSha();
  if (state.verified_base === sha) {
    return;
  }
  if (remoteSha() !== sha) {
    throw new Stop(
      "base-not-verified",
      `${BASE} (${sha.slice(0, 12)}) is not what ${REMOTE} has; push it and let CI pass first`,
    );
  }
  const ci = verifyCi(sha);
  if (ci !== "passed") {
    throw new Stop(
      "base-not-verified",
      `CI ${ci === "failed" ? "failed" : "is unverified"} on ${BASE} ${sha.slice(0, 12)}; fix it before the batch continues`,
    );
  }
  state.verified_base = sha;
  saveState(state);
}

function runTicket(state, entry) {
  const marks = mergeState(entry.slug);
  if (marks === "merged") {
    log(`ticket ${entry.number} is already merged on ${BASE}; continuing from there, never again`);
    entry.stage = "merged";
    return;
  }
  if (marks === "ambiguous") {
    throw new Stop(
      "ambiguous-merge",
      `ticket ${entry.number} is half-merged on ${BASE} (archive and merge commit disagree)`,
    );
  }
  log(`ticket ${entry.number}: running ${entry.slug} in a fresh sandbox`);
  const quarantined = new Set(rejectedRefs(entry.slug));
  const [command, ...args] = words(RUNNER);
  const result = spawnSync(command, [...args, "--ticket", entry.number], {
    cwd: root,
    stdio: "inherit",
    env: { ...env, RALPH_BATCH_ID: state.batch },
  });
  const status = result.status ?? 1;
  const after = mergeState(entry.slug);
  if (after === "merged") {
    if (status !== 0) {
      log(`the runner exited ${status}, but ${BASE} has ticket ${entry.number} merged; continuing`);
    }
    entry.stage = "merged";
    return;
  }
  if (after === "ambiguous") {
    throw new Stop("ambiguous-merge", `ticket ${entry.number} is half-merged on ${BASE}`);
  }
  if (status === PAUSED_EXIT) {
    throw new Stop(
      "paused",
      `ticket ${entry.number} is paused (usage limit or provider failure); its work is parked, run the same command again to resume`,
    );
  }
  if (status === 0) {
    throw new Stop(
      "ambiguous-merge",
      `the runner reported success, but ticket ${entry.number} is not merged on ${BASE}`,
    );
  }
  const quarantine = rejectedRefs(entry.slug).find((ref) => !quarantined.has(ref));
  if (ticketStatus(entry.slug) === "blocked" || quarantine !== undefined) {
    entry.stage = "rejected";
    const blocked =
      ticketStatus(entry.slug) === "blocked"
        ? "is blocked"
        : `is blocked on a ralph/blocked-* side branch (merge it into ${BASE})`;
    throw new Stop(
      "rejected",
      `ticket ${entry.number} was rejected and ${blocked}; see its rejected/* branch and .ralph/logs`,
    );
  }
  throw new Stop(
    "runner-failed",
    `the runner failed (exit ${status}) before ticket ${entry.number} was merged or rejected`,
  );
}

function pushBase(entry) {
  entry.sha = baseSha();
  if (remoteSha() !== entry.sha) {
    const result = git("push", "--quiet", REMOTE, BASE);
    if (result.status !== 0 || remoteSha() !== entry.sha) {
      throw new Stop(
        "push-failed",
        `could not push ${BASE} ${entry.sha.slice(0, 12)} to ${REMOTE}: ${result.stderr.trim()}`,
      );
    }
  }
  entry.stage = "pushed";
}

function checkCi(state, entry) {
  const ci = verifyCi(entry.sha);
  entry.ci = ci;
  if (ci === "failed") {
    entry.stage = "ci-failed";
    throw new Stop(
      "ci-failed",
      `CI failed on ${BASE} ${entry.sha.slice(0, 12)} after ticket ${entry.number}`,
    );
  }
  if (ci !== "passed") {
    throw new Stop(
      "ci-unverified",
      `CI on ${entry.sha.slice(0, 12)} could not be confirmed; rerun once it has finished`,
    );
  }
  entry.stage = "verified";
  state.verified_base = entry.sha;
}

// Moves the in-flight ticket through its remaining checkpoints, saving after each.
function advance(state, entry) {
  const steps = { running: runTicket, merged: (_s, e) => pushBase(e), pushed: checkCi };
  while (steps[entry.stage]) {
    try {
      steps[entry.stage](state, entry);
    } finally {
      saveState(state);
    }
  }
}

function runBatch(state) {
  for (;;) {
    const inFlight = state.tickets.find((entry) => entry.stage !== "verified");
    if (inFlight) {
      advance(state, inFlight);
    }
    const verified = state.tickets.filter((entry) => entry.stage === "verified").length;
    if (verified >= state.max_tickets) {
      throw new Stop(
        "batch-limit",
        `${verified} of ${state.max_tickets} ticket(s) merged and verified by CI`,
      );
    }
    ensureBaseVerified(state);
    const { next, waiting } = selectNext();
    if (!next) {
      if (waiting.length > 0) {
        throw new Stop(
          "unresolved-dependency",
          `no ticket is eligible; waiting on unfinished blockers: ${waiting.join(", ")}`,
        );
      }
      throw new Stop("no-eligible-ticket", "no ticket is ready");
    }
    if (state.tickets.some((entry) => entry.number === next.number)) {
      throw new Stop(
        "ambiguous-merge",
        `ticket ${next.number} was already handled in this batch, yet is selected again`,
      );
    }
    state.tickets.push({
      number: next.number,
      slug: next.slug,
      stage: "running",
      base: baseSha(),
      sha: null,
      ci: null,
    });
    saveState(state);
  }
}

function report(state) {
  log(`batch ${state.batch}: max ${state.max_tickets} ticket(s), status ${state.status}`);
  for (const entry of state.tickets) {
    const sha = entry.sha ? ` ${entry.sha.slice(0, 12)}` : "";
    log(
      `  ${entry.number} ${entry.slug.padEnd(48)} ${entry.stage}${sha}${entry.ci ? ` CI ${entry.ci}` : ""}`,
    );
  }
  if (state.stop) {
    const kind =
      state.status === "finished"
        ? "FINISHED"
        : RESUMABLE.has(state.stop.reason)
          ? "STOPPED (resumable)"
          : "STOPPED";
    log(`${kind}: ${state.stop.reason}: ${state.stop.detail}`);
  }
}

// The batch to run: the unfinished one (resumed with its own limit), or a new one. A batch that
// stopped on a failure is never resumed past it, nor replaced without an explicit `--new`.
function openBatch(existing, max, startNew) {
  if (existing?.status === "running") {
    if (startNew) {
      throw new Error(
        `batch ${existing.batch} is unfinished (${existing.stop?.reason ?? "interrupted"}); resume it before starting a new one`,
      );
    }
    if (max !== undefined && Number(max) !== existing.max_tickets) {
      throw new Error(
        `batch ${existing.batch} runs with --max-tickets ${existing.max_tickets}; resume it with that value or none`,
      );
    }
    log(`resuming batch ${existing.batch} (max ${existing.max_tickets} ticket(s))`);
    return existing;
  }
  if (max === undefined) {
    throw new Error("--max-tickets N is required to start a batch");
  }
  if (existing?.status === "stopped" && !startNew) {
    report(existing);
    throw new Error(
      `batch ${existing.batch} stopped on ${existing.stop?.reason}; resolve that, then start a new batch with --new`,
    );
  }
  if (existing) {
    renameSync(STATE, join(DIR, `state-${existing.batch}.json`));
  }
  const state = {
    batch: new Date().toISOString().replace(/\D/g, "").slice(0, 14),
    max_tickets: Number(max),
    status: "running",
    stop: null,
    verified_base: null,
    tickets: [],
  };
  saveState(state);
  log(`batch ${state.batch}: at most ${state.max_tickets} ticket(s), CI verified between them`);
  return state;
}

// Runs until a Stop, records it and returns the exit code; anything else is a crash.
function runUntilStop(state) {
  try {
    runBatch(state);
  } catch (error) {
    if (!(error instanceof Stop)) {
      throw error;
    }
    const finished = error.reason in EXIT ? "finished" : "stopped";
    state.status = RESUMABLE.has(error.reason) ? "running" : finished;
    state.stop = { reason: error.reason, detail: error.message, at: new Date().toISOString() };
    saveState(state);
    report(state);
    return EXIT[error.reason] ?? 1;
  }
  return 1;
}

function main() {
  const { values } = parseArgs({
    options: {
      "max-tickets": { type: "string" },
      new: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
    },
  });
  const existing = loadState();
  if (values.status) {
    existing ? report(existing) : log("no batch has run yet");
    return 0;
  }
  const max = values["max-tickets"];
  if (max !== undefined && !/^[1-9][0-9]*$/.test(max)) {
    throw new Error("--max-tickets needs a positive whole number");
  }
  const release = acquireLock();
  try {
    preflight();
    return runUntilStop(openBatch(existing, max, values.new));
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
