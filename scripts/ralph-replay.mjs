#!/usr/bin/env node
//
// Host-side replay of a rejected candidate onto the current base (ADR 0018). A slice that the
// host review blocked for a reason that lay in its TICKET, not its code, is kept on
// rejected/<slug>-<run>. After a human has fixed the ticket on the base, this script re-presents
// that exact implementation to the existing importer, so nothing about it is re-bought from a
// model and nothing is waived:
//
//   node scripts/ralph-replay.mjs --candidate rejected/<slug>-<run> --expect <full sha> [--accept]
//
// What it does, on the host, with Git plumbing and no model:
//   1. Pins the candidate: the branch must still be at --expect, be one commit on a commit that
//      is an ancestor of the base, and carry Ralph's slice subject. The branch is never written.
//   2. Reproduces its implementation changes on the base, byte for byte (same paths, modes and
//      blobs). A path that the base changed since the candidate's own base is refused: the
//      implementation would not be the one that was reviewed. Symlinks and submodules are refused.
//   3. Recreates the archival the importer expects from the BASE's ticket (ready-for-agent, with
//      the amended criteria): the ticket moves to issues/done/ as `done`, and the slice is merged
//      with an identical tree under `Merge slice/<slug>: <title>`.
//   4. Writes that as a result.bundle in a fresh run directory, the same shape a sandbox run leaves.
//   5. Re-proves RED against the base: base plus ONLY the candidate's test files must load, execute
//      and fail, in the hardened offline container of scripts/ralph-verify.mjs --red.
//   6. With --accept, hands the run to scripts/ralph-accept.mjs unchanged. That is where the path
//      rules (protected files), the debt gate, the hardened re-run of the gate and the fresh
//      Standards and Spec reviews happen. This script waives none of them and records no
//      verdict: the bundle is as untrusted as any container's.
//
// Historical evidence of the first attempt (its logs, its review) is not read.
//
// It runs on the host only, from a clean checkout of the base branch, like scripts/sandbox.sh:
// the sandbox image never carries it and the agent cannot reach it. Exit: 0 prepared (or accepted
// with --accept); 1 refused or RED not proven; otherwise ralph-accept.mjs's exit status.
//
// Environment: RALPH_BASE_BRANCH (default main). RALPH_REPLAY_RED replaces the RED command, the
// commit and the test files appended (tests only; default: the hardened container).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const BASE = env.RALPH_BASE_BRANCH || "main";
const SHA = /^[0-9a-f]{40}$/;
const QUARANTINE = /^rejected\/(\d{2}-[a-z0-9-]+)-\d{8}-\d{6}$/;
const SUBJECT = /^([a-z]+)\(slice-(\d{2})\): (.+)$/;
const TEST_FILE = /\.test\.tsx?$/;
// What the lead driver's RED proof applies to the base: the candidate's tests and their fixtures.
const TEST_PATH = /\.test\.tsx?$|(^|\/)__fixtures__\//;

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};
// Candidate-controlled text (subjects, paths) reaches the terminal only as printable ASCII.
const printable = (text) => String(text).replace(/[^ -~]/g, "?");
const log = (message) => console.error(`[ralph-replay] ${printable(message)}`);

function run(args, { input, extraEnv, cwd = root } = {}) {
  // Literal pathspecs: a path from the candidate is never git pathspec magic (`:(top)`, globs).
  const result = spawnSync("git", ["--literal-pathspecs", "-C", cwd, ...args], {
    encoding: "utf8",
    input,
    env: { ...env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
const git = (args, options) => run(args, options).replace(/\n$/, "");
const succeeds = (args) =>
  spawnSync("git", ["-C", root, ...args], { stdio: "ignore" }).status === 0;
const show = (sha, path) => {
  const result = spawnSync("git", ["-C", root, "show", `${sha}:${path}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

/** `git diff-tree -r --raw` between two commits as {path, status, oldMode, newMode, oldSha, newSha}. */
function changes(from, to) {
  const fields = run(["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", from, to])
    .split("\0")
    .filter(Boolean);
  const list = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = fields[i].slice(1).split(" ");
    list.push({ path: fields[i + 1], status, oldMode, newMode, oldSha, newSha });
  }
  return list;
}
// The blob a commit has at a path, as "mode sha", or null when it has none.
const entry = (sha, path) => {
  const listing = run(["ls-tree", "-z", sha, "--", path]).split("\0")[0];
  const match = /^(\d+) \w+ ([0-9a-f]{40})\t/.exec(listing);
  return match ? `${match[1]} ${match[2]}` : null;
};

const field = (text, name) =>
  new RegExp(`^\\*\\*${name}:\\*\\* *(.*)$`, "m").exec(text)?.[1].trim() ?? "";
const titleOf = (text) => /^# \d{2}: *(.+)$/m.exec(text)?.[1].trim() ?? "";
// As the importer reads the archive: the ticket plus `done` and a Completed line, criteria ticked.
const unarchived = (text) =>
  text
    .replace(/^(\*\*Status:\*\* ).*$/m, "$1")
    .replace(/^(\s*)- \[[ xX]\]/gm, "$1- [ ]")
    .replace(/\n\n\*\*Completed:\*\* [^\n]*$/m, "")
    .replace(/\r/g, "");

/** A tree is built in a throwaway index, so the host's own index and working tree never move. */
function buildTree(base, edits) {
  const dir = mkdtempSync(join(tmpdir(), "ralph-replay-index-"));
  const extraEnv = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    run(["read-tree", base], { extraEnv });
    for (const edit of edits) {
      if (edit.remove) {
        run(["update-index", "--force-remove", "--", edit.path], { extraEnv });
      } else {
        run(["update-index", "--add", "--cacheinfo", `${edit.mode},${edit.sha},${edit.path}`], {
          extraEnv,
        });
      }
    }
    return git(["write-tree"], { extraEnv });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The host's own record that this commit was rejected by the host review. Only the importer
// writes to the base branch, so a candidate a container quarantined itself (reject_slice) has no
// such commit: its content never went through the host review and is not replayable.
function assertHostRejected(base, name, tip, slug) {
  const subject = `chore(issues): block issues/${slug}.md after the host review`;
  const candidates = git([
    "log",
    "--first-parent",
    "--fixed-strings",
    `--grep=${subject}`,
    "--format=%H",
    base,
  ])
    .split("\n")
    .filter(Boolean);
  const recorded = candidates.some(
    (commit) =>
      git(["log", "-1", "--format=%s", commit]) === subject &&
      git(["log", "-1", "--format=%b", commit]).includes(`preserved on ${name}`) &&
      git(["log", "-1", "--format=%b", commit]).includes(tip.slice(0, 12)),
  );
  if (!recorded) {
    refuse(
      `no host-review rejection of ${name} at ${tip.slice(0, 12)} is recorded on ${BASE}'s first-parent history ("${subject}"); only a candidate the host review rejected can be replayed`,
    );
  }
}

/** Pins and reads the candidate. Nothing here can change it. */
function readCandidate(name, expect, base) {
  const match = QUARANTINE.exec(name);
  if (!match) {
    refuse(`${name} is not a quarantine branch (rejected/<NN-slug>-<yyyymmdd>-<hhmmss>)`);
  }
  const slug = match[1];
  if (!SHA.test(expect)) {
    refuse("--expect needs the candidate's full 40-character commit");
  }
  const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
  if (tip !== expect) {
    refuse(
      `${name} is at ${tip}, not at the expected ${expect}: the candidate is not the one you pinned`,
    );
  }
  const parents = git(["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1);
  if (parents.length !== 1) {
    refuse(`${name} is not one commit on one parent`);
  }
  assertHostRejected(base, name, tip, slug);
  const [origin] = parents;
  if (!succeeds(["merge-base", "--is-ancestor", origin, base])) {
    refuse(`the candidate's own base ${origin.slice(0, 12)} is not part of ${BASE}'s history`);
  }
  const subject = git(["log", "-1", "--format=%s", tip]);
  const parsed = SUBJECT.exec(subject);
  if (!parsed || parsed[2] !== slug.slice(0, 2)) {
    refuse(
      `${tip.slice(0, 12)} is not a slice commit for ticket ${slug.slice(0, 2)}: "${subject}"`,
    );
  }
  return { name, slug, tip, origin, subject };
}

/** The implementation a candidate is: everything but its ticket archival. */
function implementation(candidate) {
  const active = `issues/${candidate.slug}.md`;
  const archived = `issues/done/${candidate.slug}.md`;
  const all = changes(candidate.origin, candidate.tip);
  const moved = all.filter((change) => change.path === active || change.path === archived);
  const removed = moved.some((c) => c.path === active && c.status === "D");
  const added = moved.some((c) => c.path === archived && c.status === "A");
  if (moved.length !== 2 || !removed || !added) {
    refuse(`${candidate.name} does not archive ${active} as ${archived}`);
  }
  const rest = all.filter((change) => !moved.includes(change));
  if (rest.length === 0) {
    refuse(`${candidate.name} changes nothing besides its ticket`);
  }
  for (const change of rest) {
    // Printable ASCII only, and no component that could be read as an option by the tools that
    // later receive the path: what is replayed must be exactly what the importer will see.
    if (/[^ -~]/.test(change.path) || change.path.split("/").some((part) => part.startsWith("-"))) {
      refuse(`${candidate.name} has a path the replay will not carry: ${change.path}`);
    }
    if (change.path.startsWith("issues/")) {
      refuse(
        `${candidate.name} also changes ${change.path}; a slice may only archive its own ticket`,
      );
    }
    for (const mode of [change.oldMode, change.newMode]) {
      if (mode === "120000" || mode === "160000") {
        refuse(`${candidate.name} adds or changes a symlink or submodule at ${change.path}`);
      }
    }
  }
  return { rest };
}

/** The same implementation must be applicable to the base as it was to the candidate's own base. */
function assertSameGround(candidate, base, rest) {
  for (const { path } of rest) {
    if (entry(candidate.origin, path) !== entry(base, path)) {
      refuse(
        `incorrect base: ${path} on ${BASE} differs from the candidate's own base ${candidate.origin.slice(0, 12)}, so the implementation would not be the one that was reviewed`,
      );
    }
  }
}

function archive(ticketText, label, date) {
  return ticketText.replace(
    /^\*\*Status:\*\* .*$/m,
    `**Status:** done\n\n**Completed:** ${date} by ${label}`,
  );
}

function buildReplay(candidate, base, date) {
  const { rest } = implementation(candidate);
  assertSameGround(candidate, base, rest);

  const active = `issues/${candidate.slug}.md`;
  const ticket = show(base, active);
  if (ticket === null || field(ticket, "Status") !== "ready-for-agent") {
    refuse(`${active} must be ready-for-agent on ${BASE}; unblock it in a reviewed commit first`);
  }
  // The ticket may be amended, but the archive the candidate was reviewed against must be the same
  // ticket apart from that: criteria changed by hand do not slip in through the old archive.
  const oldTicket = show(candidate.origin, active);
  const oldArchive = show(candidate.tip, `issues/done/${candidate.slug}.md`);
  if (
    oldTicket === null ||
    oldArchive === null ||
    unarchived(oldArchive) !== unarchived(oldTicket)
  ) {
    refuse(`${candidate.name} changed its ticket beyond marking it done`);
  }
  const type = field(ticket, "Type") || "feat";
  const title = titleOf(ticket);
  const expected = `${type}(slice-${candidate.slug.slice(0, 2)}): ${title}`;
  if (candidate.subject !== expected) {
    refuse(
      `the candidate's subject "${candidate.subject}" is not "${expected}" for the ticket on ${BASE}`,
    );
  }

  const archivedText = archive(
    ticket,
    `slice/${candidate.slug} (replay of ${candidate.tip.slice(0, 12)})`,
    date,
  );
  const blob = git(["hash-object", "-w", "--stdin"], { input: archivedText });
  const edits = [
    ...rest.map((change) =>
      change.status === "D"
        ? { path: change.path, remove: true }
        : { path: change.path, mode: change.newMode, sha: change.newSha },
    ),
    { path: active, remove: true },
    { path: `issues/done/${candidate.slug}.md`, mode: "100644", sha: blob },
  ];
  const tree = buildTree(base, edits);

  // The implementation on the base must be exactly the candidate's: same paths, modes, blobs.
  const key = (c) => `${c.path} ${c.status} ${c.newMode} ${c.newSha}`;
  const wanted = rest.map(key).sort().join("\n");
  const got = changes(base, tree)
    .filter((c) => !c.path.startsWith("issues/"))
    .map(key)
    .sort()
    .join("\n");
  if (wanted !== got) {
    refuse(
      "the reproduced implementation differs from the candidate's (this is a bug in the replay)",
    );
  }

  const message = [
    candidate.subject,
    "",
    `Replay of ${candidate.tip} (${candidate.name}) onto ${base}: its implementation is`,
    "reproduced byte for byte; only the ticket archival is new, from the ticket now on the base.",
    "Produced by scripts/ralph-replay.mjs (ADR 0018), not by a model. RED is re-proved on this base,",
    "and the importer runs the debt gate, the hardened gate and a fresh independent review.",
    "",
    `Refs: issues/done/${candidate.slug}.md`,
  ].join("\n");
  const slice = git(["commit-tree", tree, "-p", base, "-m", message]);
  const merge = git([
    "commit-tree",
    tree,
    "-p",
    base,
    "-p",
    slice,
    "-m",
    `Merge slice/${candidate.slug}: ${title}`,
  ]);
  return { rest, slice, merge, tree, title };
}

/** The result.bundle a container would leave: `main` at the merge, `slice/<slug>` at the slice. */
function writeRun(candidate, built, base) {
  const id = `replay-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${process.pid}`;
  const runDir = join(root, ".ralph", "sandbox", id);
  const out = join(runDir, "out");
  mkdirSync(join(out, "state"), { recursive: true });
  mkdirSync(join(out, "logs"), { recursive: true });
  // Private refs name the unreferenced commits for the one fetch; they are removed straight away.
  const prefix = `refs/ralph/replay/${id}`;
  const scratch = mkdtempSync(join(tmpdir(), "ralph-replay-bundle-"));
  try {
    git(["update-ref", `${prefix}/main`, built.merge]);
    git(["update-ref", `${prefix}/slice`, built.slice]);
    run(["init", "--quiet", "--bare", scratch]);
    run(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        root,
        `${prefix}/main:refs/heads/${BASE}`,
        `${prefix}/slice:refs/heads/slice/${candidate.slug}`,
      ],
      { cwd: scratch },
    );
    run(["bundle", "create", "--quiet", join(out, "result.bundle"), "--branches"], {
      cwd: scratch,
    });
  } catch (error) {
    // A half-made run directory must not look like a prepared one.
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  } finally {
    succeeds(["update-ref", "-d", `${prefix}/main`]);
    succeeds(["update-ref", "-d", `${prefix}/slice`]);
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(
    join(out, "logs", "replay.json"),
    `${JSON.stringify({ candidate: candidate.name, candidateCommit: candidate.tip, base, slice: built.slice, merge: built.merge }, null, 2)}\n`,
  );
  return runDir;
}

/** RED against the base: the base plus only the candidate's test files must fail on assertions. */
function proveRed(rest, base) {
  const tests = rest.filter((c) => c.status !== "D" && TEST_PATH.test(c.path));
  const files = tests.filter((c) => TEST_FILE.test(c.path)).map((c) => c.path);
  if (files.length === 0) {
    refuse("the candidate has no test file, so RED cannot be proven");
  }
  const tree = buildTree(
    base,
    tests.map((c) => ({ path: c.path, mode: c.newMode, sha: c.newSha })),
  );
  const red = git([
    "commit-tree",
    tree,
    "-p",
    base,
    "-m",
    "RED: the base plus the candidate's tests only",
  ]);
  const command = env.RALPH_REPLAY_RED ?? "node scripts/ralph-verify.mjs --red";
  if (env.RALPH_REPLAY_RED !== undefined) {
    log(`WARNING: RALPH_REPLAY_RED replaces the hardened RED container with: ${command}`);
  } else {
    const image = env.RALPH_IMAGE || "ticketarena-sandbox";
    log(`building the sandbox image ${image}`);
    const built = spawnSync("docker", ["build", "--quiet", "--tag", image, root], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (built.status !== 0) {
      throw new Error("could not build the sandbox image");
    }
  }
  const [program, ...prefix] = command.split(" ").filter(Boolean);
  log(`re-proving RED for ${files.length} test file(s) on ${base.slice(0, 12)}`);
  const result = spawnSync(program, [...prefix, red, ...files], { cwd: root, stdio: "inherit" });
  return result.status === 0;
}

function hostReady() {
  if (git(["symbolic-ref", "--short", "HEAD"]) !== BASE) {
    refuse(`check out '${BASE}' first`);
  }
  if (git(["status", "--porcelain"]) !== "") {
    refuse("the working tree is not clean; commit or stash first");
  }
}

export function replay(options) {
  const {
    candidate: name,
    expect,
    accept = false,
    date = new Date().toISOString().slice(0, 10),
  } = options;
  hostReady();
  const base = git(["rev-parse", `refs/heads/${BASE}`]);
  const candidate = readCandidate(name, expect, base);
  const built = buildReplay(candidate, base, date);
  log(
    `reproduced ${built.rest.length} implementation change(s) of ${candidate.tip.slice(0, 12)} on ${base.slice(0, 12)}`,
  );
  if (!proveRed(built.rest, base)) {
    log("RED is NOT proven on the base: nothing is imported, the host is unchanged");
    return { exit: 1 };
  }
  const runDir = writeRun(candidate, built, base);
  const acceptArgs = [
    join(root, "scripts", "ralph-accept.mjs"),
    "--run-dir",
    runDir,
    "--base",
    base,
    "--exit",
    "0",
    "--ticket",
    candidate.slug.slice(0, 2),
  ];
  if (!accept) {
    log(`prepared ${runDir}. To run the importer (gate, debt gate, fresh reviews):`);
    log(`  node ${acceptArgs.join(" ")}`);
    return { exit: 0, runDir, base };
  }
  const result = spawnSync(process.execPath, acceptArgs, { cwd: root, stdio: "inherit" });
  const status = result.status ?? 1;
  // As sandbox.sh: a refused or failed run keeps its directory for inspection.
  if (status === 0) {
    rmSync(runDir, { recursive: true, force: true });
  }
  return { exit: status, runDir, base };
}

function main() {
  const { values } = parseArgs({
    options: {
      candidate: { type: "string" },
      expect: { type: "string" },
      accept: { type: "boolean", default: false },
    },
  });
  if (!(values.candidate && values.expect)) {
    throw new Refusal(
      "usage: ralph-replay.mjs --candidate rejected/<slug>-<run> --expect <sha> [--accept]",
    );
  }
  return replay({ candidate: values.candidate, expect: values.expect, accept: values.accept }).exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    log(
      `${error instanceof Refusal ? "REFUSED" : "ERROR"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
