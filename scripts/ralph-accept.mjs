#!/usr/bin/env node
//
// The trusted half of the sandbox boundary (ADR 0014). It runs on the HOST after every agent
// sandbox run and is the only code that changes the host repository from a run's output:
//
//   node scripts/ralph-accept.mjs --run-dir <.ralph/sandbox/<id>> --base <sha> --exit <code>
//                                 [--ticket NN]
//
// Everything in <run-dir>/out was written by the container, which the agent fully controls.
// result.bundle, state/ and logs/ are therefore untrusted data. Nothing here executes from them
// or runs Git inside a repository the container wrote: the bundle is read by this repository's
// own Git, and its branches land in a quarantine namespace (refs/ralph/incoming/<id>/). The host
// repository moves only once every check passes:
//
//   - `main` may only gain what Ralph produces. That is a slice merge: one squashed commit on the
//     verified base, under `Merge slice/<slug>: <title>` with an identical tree, for a ticket that
//     was ready on the base with every blocker done, archived as done with nothing else in
//     issues/ changed. Or it is a blocked-status commit that changes only that ticket's status
//     line. The first-parent chain must hold nothing else.
//   - No change may touch a protected path (the harness, the gate configuration, CI, review
//     skills, the root package.json scripts), Git attributes or submodules, or add a symlink or
//     submodule. So the host scripts the batch runs, and the gate the agent is judged by, cannot
//     change through a run.
//   - The full quality gate passes again on the merged tree, in a fresh sandbox with no agent
//     (RALPH_ACCEPT_VERIFY).
//   - A pause is adopted only if it is exactly what Ralph writes for the ticket's parked ref. It
//     must sit on the base the run started from, with `paused^ = gated`, and the parked work must
//     pass the same path rules. The host rewrites it in canonical form.
//
// Logs are copied to .ralph/logs as plain files (symlinks and special files are dropped),
// redacted with the host's secrets, and never consulted for a decision.
//
// Exit: 0 accepted (merged, or nothing to do); 75 paused; 1 rejected (blocked) or failed;
//       3 refused as untrusted: the host repository is unchanged and the result is kept in
//       refs/ralph/incoming/<id>/ and <run-dir> for inspection.
//
// Environment: RALPH_BASE_BRANCH (default main), RALPH_ACCEPT_VERIFY (re-runs the gate on a
// commit, its sha appended; default: bash scripts/sandbox.sh --verify), RALPH_MAX_ATTEMPTS and
// RALPH_MAX_REVIEW_ROUNDS (the limits a pause may claim; defaults 5 and 3, as ralph-loop.sh).

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { cleanup, initRoot, redactRun, secretValues } from "./ralph-artifacts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const BASE = env.RALPH_BASE_BRANCH || "main";
const VERIFY = env.RALPH_ACCEPT_VERIFY ?? "bash scripts/sandbox.sh --verify";
const MAX_ATTEMPTS = Number(env.RALPH_MAX_ATTEMPTS || 5);
const MAX_ROUNDS = Number(env.RALPH_MAX_REVIEW_ROUNDS || 3);
const LOG_ROOT = join(root, ".ralph/logs");
const STATE_DIR = join(root, ".ralph/state");
const PAUSED_EXIT = 75;
const UNTRUSTED_EXIT = 3;
const ZERO = "0".repeat(40);
const MAX_STATE_BYTES = 8 * 1024 * 1024;

// The harness and everything that defines its gate: a slice that changes any of it could change
// what judges the next slice, or what the host runs between tickets. Changing it takes a
// human-reviewed commit.
export const PROTECTED_FILES = [
  "ralph-loop.sh",
  "Dockerfile",
  ".dockerignore",
  "CLAUDE.md",
  "biome.json",
  "tsconfig.base.json",
  "turbo.json",
  ".npmrc",
  ".pnpmfile.cjs",
];
export const PROTECTED_DIRS = ["scripts/", ".github/", "skills/", ".claude/", "docs/workflow/"];
// Anywhere in the tree: they bring Git filters, diff drivers or other repositories with them.
const GIT_METADATA = [".gitattributes", ".gitmodules"];
const COMMIT_TYPES = ["feat", "fix", "refactor", "perf", "test", "docs", "chore"];
const SLUG = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}$/;
const PAUSE_KEYS = [
  "ticket",
  "ref",
  "base",
  "gated",
  "paused",
  "phase",
  "attempt",
  "round",
  "reason",
  "run",
];
const PAUSE_DATA = [".feedback.log", ".blocking.md"];

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};
// Paths and ref names in messages come from the container: control characters are masked so
// they cannot rewrite the operator's terminal.
const printable = (text) =>
  [...text]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? "?" : char))
    .join("");
const log = (message) => console.error(`[ralph-accept] ${printable(message)}`);

// --- Git (always this repository's own Git, never one the container wrote) -------------------

function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function gitOut(...args) {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.replace(/\n$/, "");
}
const parents = (sha) => gitOut("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
const tree = (sha) => gitOut("rev-parse", `${sha}^{tree}`);
const subject = (sha) => gitOut("log", "-1", "--format=%s", sha);
const isAncestor = (a, b) => git(["merge-base", "--is-ancestor", a, b]).status === 0;
function show(sha, path) {
  const result = git(["show", `${sha}:${path}`]);
  return result.status === 0 ? result.stdout : null;
}
function lsTree(sha, dir) {
  return gitOut("ls-tree", "--name-only", sha, `${dir}/`).split("\n").filter(Boolean);
}

// Raw diff without renames, textconv or external drivers: modes, status and path of every change.
function changes(from, to) {
  const out = gitOut(
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    from,
    to,
  );
  const fields = out.split("\0");
  const list = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, , , status] = fields[i].replace(/^:/, "").split(" ");
    list.push({ oldMode, newMode, status, path: fields[i + 1] });
  }
  return list;
}

// --- Tickets (contract: issues/README.md) ----------------------------------------------------

const field = (text, name) =>
  new RegExp(`^\\*\\*${name}:\\*\\* *(.*)$`, "m").exec(text)?.[1]?.replace(/\r$/, "").trim() ?? "";
const titleOf = (text) => /^# \d{2}: *(.*)$/m.exec(text)?.[1]?.replace(/\r$/, "").trim() ?? "";

function ticketFileAt(sha, number) {
  const matches = [...lsTree(sha, "issues"), ...lsTree(sha, "issues/done")].filter(
    (path) => basename(path).startsWith(`${number}-`) && path.endsWith(".md"),
  );
  return matches.length === 1 ? matches[0] : null;
}

// The ticket as it stood on `sha` must have been eligible there, as next_ticket decides.
function eligibleTicket(sha, slug) {
  const text = show(sha, `issues/${slug}.md`);
  if (text === null) {
    refuse(`ticket issues/${slug}.md does not exist on ${short(sha)}`);
  }
  if (field(text, "Status") !== "ready-for-agent") {
    refuse(`ticket ${slug} was not ready-for-agent on ${short(sha)}`);
  }
  const blockers = field(text, "Blocked by");
  if (blockers === "") {
    refuse(`ticket ${slug} has no Blocked by line`);
  }
  if (!blockers.startsWith("None")) {
    for (const number of blockers.replace(/\([^)]*\)/g, "").match(/\b\d{2}\b/g) ?? []) {
      const file = ticketFileAt(sha, number);
      const done = file !== null && field(show(sha, file) ?? "", "Status") === "done";
      if (!done) {
        refuse(`ticket ${slug} is blocked by ${number}, which is not done on ${short(sha)}`);
      }
    }
  }
  return text;
}

// --- Path rules ---------------------------------------------------------------------------------

const short = (sha) => sha.slice(0, 12);
const isProtected = (path) =>
  PROTECTED_FILES.includes(path) || PROTECTED_DIRS.some((dir) => path.startsWith(dir));

function rootScripts(sha) {
  const text = show(sha, "package.json");
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text).scripts ?? null;
  } catch {
    return Symbol("unparseable");
  }
}

// What is wrong with one change, or null. `issues` judges a change under issues/ (true = allowed).
function changeError({ path, newMode, status }, issues) {
  const parts = path.split("/");
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    return "a .git path component";
  }
  if (GIT_METADATA.includes(parts.at(-1) ?? "")) {
    return "Git attributes and submodules cannot change through a run";
  }
  if (isProtected(path)) {
    return "protected harness or gate file";
  }
  if (status !== "D" && (newMode === "120000" || newMode === "160000")) {
    return newMode === "120000" ? "symlink" : "submodule";
  }
  if (path.startsWith("issues/") && !issues({ path, status })) {
    return "only the ticket's own file may change in issues/";
  }
  return null;
}

/** Problems with the changes between two commits, whoever made them. */
function pathErrors(from, to, issues) {
  const errors = [];
  for (const change of changes(from, to)) {
    const error = changeError(change, issues);
    if (error) {
      errors.push(`${change.path}: ${error}`);
    } else if (
      change.path === "package.json" &&
      !isDeepStrictEqual(rootScripts(from), rootScripts(to))
    ) {
      errors.push("package.json: the root scripts define the gate and cannot change through a run");
    }
  }
  return errors;
}

function assertPaths(from, to, issues, what) {
  const errors = pathErrors(from, to, issues);
  if (errors.length > 0) {
    refuse(`${what}: ${errors.join("; ")}`);
  }
}

// --- What main may gain -----------------------------------------------------------------------

// The archive is the ticket plus `done` and its Completed line (archive_ticket), with acceptance
// criteria ticked off as the agent met them. Nothing else may change: the ticket is the spec.
const unarchived = (text) =>
  text
    .replace(/^(\*\*Status:\*\* ).*$/m, "$1")
    .replace(/^(\s*)- \[[ xX]\]/gm, "$1- [ ]")
    .replace(/\n\n\*\*Completed:\*\* [^\n]*$/m, "")
    .replace(/\r/g, "");

function slugTicket(slug, only) {
  if (!SLUG.test(slug)) {
    refuse(`${slug} is not a ticket slug`);
  }
  if (only && slug.slice(0, 2) !== only) {
    refuse(`ticket ${slug.slice(0, 2)} was not the ticket this run was given (${only})`);
  }
}

function sliceMerge(prev, merge, slice, only) {
  const match = /^Merge slice\/(\S+): (.+)$/.exec(subject(merge));
  if (!match) {
    refuse(`${short(merge)} is a merge, but not "Merge slice/<slug>: <title>"`);
  }
  const [, slug, title] = match;
  slugTicket(slug, only);
  if (!isDeepStrictEqual(parents(slice), [prev])) {
    refuse(`slice ${short(slice)} of ${slug} is not one commit on ${short(prev)}`);
  }
  if (tree(merge) !== tree(slice)) {
    refuse(`merge ${short(merge)} of ${slug} changes more than its slice`);
  }
  const ticket = eligibleTicket(prev, slug);
  const type = field(ticket, "Type") || "feat";
  if (titleOf(ticket) !== title || !COMMIT_TYPES.includes(type)) {
    refuse(`merge ${short(merge)} does not carry ticket ${slug}'s title or type`);
  }
  if (subject(slice) !== `${type}(slice-${slug.slice(0, 2)}): ${title}`) {
    refuse(`slice ${short(slice)} is not "${type}(slice-${slug.slice(0, 2)}): ${title}"`);
  }
  const active = `issues/${slug}.md`;
  const archived = `issues/done/${slug}.md`;
  const moved = new Set();
  assertPaths(
    prev,
    slice,
    ({ path, status }) => {
      const ok = (path === active && status === "D") || (path === archived && status === "A");
      if (ok) {
        moved.add(path);
      }
      return ok;
    },
    `slice ${slug}`,
  );
  const done = show(slice, archived) ?? "";
  if (moved.size !== 2 || field(done, "Status") !== "done" || !field(done, "Completed")) {
    refuse(`slice ${slug} does not archive its ticket as done`);
  }
  if (unarchived(done) !== unarchived(ticket)) {
    refuse(`slice ${slug} changes its ticket beyond marking it done`);
  }
  return { kind: "merged", slug, slice, merge };
}

function blockCommit(prev, commit, only) {
  const match = /^chore\(issues\): block issues\/(\S+)\.md after rejected agent run$/.exec(
    subject(commit),
  );
  if (!match) {
    refuse(`${short(commit)} is neither a slice merge nor Ralph's blocked-status commit`);
  }
  const [, slug] = match;
  slugTicket(slug, only);
  const path = `issues/${slug}.md`;
  const before = eligibleTicket(prev, slug);
  const list = changes(prev, commit);
  const after = show(commit, path) ?? "";
  const expected = before.replace(/^(\*\*Status:\*\* ).*$/m, "$1blocked");
  if (
    list.length !== 1 ||
    list[0].path !== path ||
    list[0].newMode !== "100644" ||
    after !== expected
  ) {
    refuse(`blocked-status commit ${short(commit)} changes more than ${slug}'s status line`);
  }
  return { kind: "blocked", slug, commit };
}

/** The ticket outcomes on `main` between the verified base and the result's tip. */
function mainOutcomes(base, tip, only) {
  if (!isAncestor(base, tip)) {
    refuse(`the result's ${BASE} does not build on the verified base ${short(base)}`);
  }
  const chain = gitOut("rev-list", "--first-parent", "--reverse", `${base}..${tip}`)
    .split("\n")
    .filter(Boolean);
  const outcomes = [];
  let prev = base;
  for (const commit of chain) {
    if (outcomes.some((outcome) => outcome.kind === "blocked")) {
      refuse(`${BASE} moved on after a rejection, which stops the loop`);
    }
    const list = parents(commit);
    if (list[0] !== prev || list.length > 2) {
      refuse(`${short(commit)} is not a plain step on ${BASE}`);
    }
    const outcome =
      list.length === 2 ? sliceMerge(prev, commit, list[1], only) : blockCommit(prev, commit, only);
    if (outcomes.some((earlier) => earlier.slug === outcome.slug)) {
      refuse(`ticket ${outcome.slug} appears twice on ${BASE}`);
    }
    outcomes.push(outcome);
    prev = commit;
  }
  // Nothing may hide behind the first-parent chain: only the slices themselves.
  const reachable = gitOut("rev-list", `${base}..${tip}`).split("\n").filter(Boolean);
  const known = new Set([...chain, ...outcomes.filter((o) => o.slice).map((o) => o.slice)]);
  if (reachable.length !== known.size || reachable.some((sha) => !known.has(sha))) {
    refuse(`${BASE} carries commits that are neither slices nor Ralph's own`);
  }
  return outcomes;
}

// --- Pause and resume state -------------------------------------------------------------------

function readSmallFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
    refuse(`${basename(path)} is not a plain file of at most ${MAX_STATE_BYTES} bytes`);
  }
  return readFileSync(path);
}

/** The state files of the run's output, by slug; anything Ralph does not write is refused. */
function stateFiles(dir) {
  const bySlug = new Map();
  if (!existsSync(dir)) {
    return bySlug;
  }
  for (const name of readdirSync(dir)) {
    // Left behind by a pause_ticket that died before its rename: never a pause.
    if (name.endsWith(".pause.tmp")) {
      continue;
    }
    const suffix = [".pause", ...PAUSE_DATA].find((end) => name.endsWith(end));
    const slug = suffix ? name.slice(0, -suffix.length) : "";
    if (!(suffix && SLUG.test(slug))) {
      refuse(`state/${name} is not a file Ralph writes`);
    }
    const files = bySlug.get(slug) ?? {};
    files[suffix] = readSmallFile(join(dir, name));
    bySlug.set(slug, files);
  }
  return bySlug;
}

function parsePause(text, slug) {
  const lines = text.toString("utf8").replace(/\n$/, "").split("\n");
  const fields = {};
  for (const line of lines) {
    const match = /^([a-z]+)=(.*)$/.exec(line);
    if (!(match && PAUSE_KEYS.includes(match[1])) || match[1] in fields) {
      refuse(`state/${slug}.pause has an unexpected line: ${JSON.stringify(line.slice(0, 80))}`);
    }
    fields[match[1]] = match[2];
  }
  const ok =
    PAUSE_KEYS.every((key) => key in fields) &&
    fields.ticket === slug.slice(0, 2) &&
    fields.ref === `ralph/paused/${slug}` &&
    [fields.base, fields.gated, fields.paused].every((sha) => SHA.test(sha)) &&
    /^(red|green|refactor|docs|review|review-fix)$/.test(fields.phase) &&
    /^[1-9]\d*$/.test(fields.attempt) &&
    Number(fields.attempt) <= MAX_ATTEMPTS &&
    /^[1-9]\d*$/.test(fields.round) &&
    Number(fields.round) <= MAX_ROUNDS &&
    /^(usage-limit|auth|transient)$/.test(fields.reason) &&
    /^\d{8}-\d{6}$/.test(fields.run);
  if (!ok) {
    refuse(`state/${slug}.pause is malformed or does not belong to ${slug}`);
  }
  return fields;
}

const canonicalPause = (fields) => PAUSE_KEYS.map((key) => `${key}=${fields[key]}\n`).join("");

function hostState(slug) {
  const files = {};
  for (const suffix of [".pause", ...PAUSE_DATA]) {
    const path = join(STATE_DIR, `${slug}${suffix}`);
    if (existsSync(path)) {
      files[suffix] = readFileSync(path);
    }
  }
  return files;
}

const sameBytes = (a, b) => a !== undefined && b !== undefined && Buffer.compare(a, b) === 0;

/**
 * The pause this run reports, if any. State the host handed in comes back unchanged. A new or
 * changed pause must be exactly what pause_ticket writes for parked work that is in the
 * bundle.
 */
function newPause(dir, incoming, tip, status, only) {
  let found = null;
  for (const [slug, files] of stateFiles(dir)) {
    const held = hostState(slug);
    const unchanged = [".pause", ...PAUSE_DATA].every(
      (suffix) => files[suffix] === held[suffix] || sameBytes(files[suffix], held[suffix]),
    );
    if (unchanged) {
      continue;
    }
    if (found || status !== PAUSED_EXIT || !files[".pause"]) {
      refuse(`state for ${slug} changed, but this run did not pause it`);
    }
    slugTicket(slug, only);
    const fields = parsePause(files[".pause"], slug);
    if (fields.base !== tip || incoming.get(fields.ref) !== fields.paused) {
      refuse(`the pause of ${slug} does not match the result's ${BASE} and ${fields.ref}`);
    }
    if (
      !(isDeepStrictEqual(parents(fields.paused), [fields.gated]) && isAncestor(tip, fields.gated))
    ) {
      refuse(`${fields.ref} does not park its work on the recorded checkpoint`);
    }
    eligibleTicket(tip, slug);
    const own = `issues/${slug}.md`;
    assertPaths(tip, fields.paused, ({ path, status: s }) => path === own && s === "M", fields.ref);
    found = { slug, fields, files };
  }
  return found;
}

// --- Logs -------------------------------------------------------------------------------------

// Plain files and directories only. A symlink could point anywhere on the host once copied out
// of the container, so it is dropped, as are devices and sockets. Existing files win.
function copyLogs(from, to, copied = new Set()) {
  if (!existsSync(from)) {
    return copied;
  }
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      copied.add(target);
      copyLogs(source, target, copied);
    } else if (stat.isFile()) {
      if (!existsSync(target)) {
        copyFileSync(source, target);
      }
    } else {
      log(`dropped ${name} from the logs: not a plain file`);
    }
  }
  return copied;
}

function importLogs(outDir) {
  try {
    initRoot(LOG_ROOT);
    const runs = readdirSync(join(outDir, "logs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
      .map((entry) => entry.name);
    for (const run of runs) {
      copyLogs(join(outDir, "logs", run), join(LOG_ROOT, run));
      redactRun(join(LOG_ROOT, run), secretValues(env));
    }
    cleanup({ reviewRoot: join(root, ".ralph/review"), logRoot: LOG_ROOT });
  } catch (error) {
    // Evidence only: a broken log never decides, and never hides, a run's outcome.
    log(`could not import every log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Acceptance -------------------------------------------------------------------------------

function hostReady(base) {
  if (gitOut("symbolic-ref", "--short", "HEAD") !== BASE) {
    return `the host is no longer on ${BASE}`;
  }
  if (gitOut("status", "--porcelain") !== "") {
    return "the host working tree changed during the run";
  }
  if (gitOut("rev-parse", `refs/heads/${BASE}`) !== base) {
    return `${BASE} moved on the host during the run`;
  }
  return null;
}

function fetchBundle(bundle, namespace) {
  if (git(["bundle", "verify", "--quiet", bundle]).status !== 0) {
    refuse("result.bundle is not a valid Git bundle for this repository");
  }
  const fetched = git([
    "-c",
    "transfer.fsckObjects=true",
    "-c",
    "fetch.fsckObjects=true",
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    bundle,
    `+refs/heads/*:${namespace}/*`,
  ]);
  if (fetched.status !== 0) {
    refuse(`result.bundle could not be fetched: ${fetched.stderr.trim()}`);
  }
  const incoming = new Map();
  for (const line of gitOut("for-each-ref", "--format=%(objectname) %(refname)", `${namespace}/`)
    .split("\n")
    .filter(Boolean)) {
    const [sha, ref] = line.split(" ");
    incoming.set(ref.slice(namespace.length + 1), sha);
  }
  return incoming;
}

function verifyGate(sha) {
  log(`re-running the quality gate on ${short(sha)} in a fresh sandbox without an agent`);
  const [command, ...args] = VERIFY.split(" ").filter(Boolean);
  const result = spawnSync(command, [...args, sha], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    refuse(`the quality gate failed on ${short(sha)} when the host ran it again`);
  }
}

function writeState(slug, files) {
  mkdirSync(STATE_DIR, { recursive: true });
  for (const suffix of [".pause", ...PAUSE_DATA]) {
    rmSync(join(STATE_DIR, `${slug}${suffix}`), { force: true });
  }
  for (const suffix of PAUSE_DATA.filter((end) => files[end])) {
    writeFileSync(join(STATE_DIR, `${slug}${suffix}`), files[suffix]);
  }
  // Written last, as pause_ticket does: without it a rerun starts the ticket from scratch.
  writeFileSync(join(STATE_DIR, `${slug}.pause.tmp`), canonicalPause(files.fields));
  renameSync(join(STATE_DIR, `${slug}.pause.tmp`), join(STATE_DIR, `${slug}.pause`));
}

function clearState(slug) {
  for (const suffix of [".pause", ...PAUSE_DATA]) {
    rmSync(join(STATE_DIR, `${slug}${suffix}`), { force: true });
  }
  if (git(["show-ref", "--verify", "--quiet", `refs/heads/ralph/paused/${slug}`]).status === 0) {
    gitOut("update-ref", "-d", `refs/heads/ralph/paused/${slug}`);
  }
}

// New branches only, never one the host already has: evidence cannot overwrite anything.
function createBranch(name, sha) {
  const result = git(["update-ref", `refs/heads/${name}`, sha, ZERO]);
  if (result.status !== 0) {
    log(`kept the host's existing ${name}; the run's copy stays in the quarantine namespace`);
  }
}

/** Everything the run's output claims, validated; refuses on the first thing that is not. */
function validate(outDir, { base, status, only, namespace }) {
  const incoming = fetchBundle(join(outDir, "result.bundle"), namespace);
  const tip = incoming.get(BASE) ?? refuse(`result.bundle has no ${BASE} branch`);
  const outcomes = mainOutcomes(base, tip, only);
  const pause = newPause(join(outDir, "state"), incoming, tip, status, only);
  const merges = outcomes.filter((outcome) => outcome.kind === "merged");
  for (const { slug, slice } of merges) {
    const branch = incoming.get(`slice/${slug}`);
    if (branch !== undefined && branch !== slice) {
      refuse(`slice/${slug} is not the slice merged into ${BASE}`);
    }
  }
  if (merges.length > 0) {
    verifyGate(merges.at(-1).merge);
  }
  const blocked = outcomes.find((outcome) => outcome.kind === "blocked");
  const quarantines = [...incoming].filter(([name]) => {
    const match = /^rejected\/(\d{2}-[a-z0-9-]+)-\d{8}-\d{6}$/.exec(name);
    return match !== null && blocked?.slug === match[1];
  });
  return { incoming, tip, outcomes, pause, blocked, quarantines };
}

function apply({ tip, outcomes, pause, quarantines }, { base, namespace }) {
  if (tip !== base) {
    gitOut("merge", "--ff-only", "--quiet", tip);
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "merged") {
      createBranch(`slice/${outcome.slug}`, outcome.slice);
    }
    clearState(outcome.slug);
    log(`accepted: ticket ${outcome.slug} ${outcome.kind}`);
  }
  for (const [name, sha] of quarantines) {
    createBranch(name, sha);
  }
  if (pause) {
    gitOut("update-ref", `refs/heads/${pause.fields.ref}`, pause.fields.paused);
    writeState(pause.slug, { ...pause.files, fields: pause.fields });
    log(`accepted: ticket ${pause.slug} paused in ${pause.fields.phase} (${pause.fields.reason})`);
  }
  for (const ref of gitOut("for-each-ref", "--format=%(refname)", `${namespace}/`).split("\n")) {
    if (ref !== "") {
      gitOut("update-ref", "-d", ref);
    }
  }
}

function decide(runDir, run) {
  const outDir = join(runDir, "out");
  if (!existsSync(join(outDir, "result.bundle"))) {
    log("the run produced no result.bundle; nothing to accept");
    return { exit: 1, outcome: "no-result" };
  }
  const plan = validate(outDir, run);
  const problem = hostReady(run.base);
  if (problem) {
    log(`${problem}; refusing to apply the run`);
    return { exit: 1, outcome: "host-changed" };
  }
  apply(plan, run);
  if (plan.pause) {
    return { exit: PAUSED_EXIT, outcome: "paused" };
  }
  if (plan.blocked) {
    return { exit: 1, outcome: "rejected" };
  }
  if (run.status !== 0) {
    return { exit: 1, outcome: "failed" };
  }
  return { exit: 0, outcome: plan.outcomes.length > 0 ? "merged" : "nothing" };
}

function main() {
  const { values } = parseArgs({
    options: {
      "run-dir": { type: "string" },
      base: { type: "string" },
      exit: { type: "string" },
      ticket: { type: "string" },
    },
  });
  const runDir = resolve(values["run-dir"] ?? "");
  const base = values.base ?? "";
  const status = Number(values.exit);
  if (!(values["run-dir"] && SHA.test(base) && Number.isInteger(status))) {
    throw new Error(
      "usage: ralph-accept.mjs --run-dir <dir> --base <sha> --exit <code> [--ticket NN]",
    );
  }
  if (values.ticket !== undefined && !/^\d{2}$/.test(values.ticket)) {
    throw new Error("--ticket needs a two-digit number");
  }
  const namespace = `refs/ralph/incoming/${basename(runDir)}`;
  importLogs(join(runDir, "out"));
  let verdict;
  try {
    verdict = decide(runDir, { base, status, only: values.ticket, namespace });
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    log(`REFUSED: ${error.message}`);
    log(`the host repository is unchanged; the result is kept in ${namespace}/ and ${runDir}`);
    verdict = { exit: UNTRUSTED_EXIT, outcome: "untrusted", reason: error.message };
  }
  writeFileSync(join(runDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
