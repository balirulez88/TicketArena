// Tests for scripts/ralph-host-review.mjs, the host's own review of a candidate (ADR 0015, TD-058).
// The module runs in a throwaway repository with a stub in place of the reviewer container
// (RALPH_HOST_REVIEWER), which records what each reviewer was given. End-to-end behaviour, as the
// importer applies it, is in scripts/ralph-accept.test.mjs; real containers in sandbox.test.sh.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("..", import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

// The reviewer container's stand-in. It lists its input, reads the bundle's refs with Git, and
// answers like the shared stub reviewer in a checkout of the commit it was given. STUB_FAIL_ONCE
// makes its first session fail as an overloaded provider would.
const REVIEWER = `
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const input = process.argv.at(-1);
const log = process.env.STUB_LOG;
const heads = spawnSync("git", ["bundle", "list-heads", join(input, "repo.bundle")], { encoding: "utf8" }).stdout.trim();
appendFileSync(log, JSON.stringify({ axis: process.env.RALPH_REVIEW_AXIS, files: readdirSync(input).sort(), heads, commit: process.env.RALPH_REVIEW_COMMIT }) + "\\n");
if (process.env.STUB_FAIL_ONCE && !existsSync(process.env.STUB_FAIL_ONCE)) {
  writeFileSync(process.env.STUB_FAIL_ONCE, "failed once\\n");
  console.log("API Error: 529 overloaded_error");
  process.exit(1);
}
const ws = mkdtempSync(join(tmpdir(), "ralph-review-ws-"));
const git = (...args) => spawnSync("git", args, { cwd: ws, encoding: "utf8" });
git("init", "--quiet", ".");
git("fetch", "--quiet", "--no-tags", join(input, "repo.bundle"), "+refs/*:refs/bundle/*");
git("-c", "advice.detachedHead=false", "checkout", "--quiet", process.env.RALPH_REVIEW_COMMIT);
const changeset = readFileSync(join(input, "changeset.path"), "utf8");
mkdirSync(dirname(join(ws, changeset)), { recursive: true });
copyFileSync(join(input, "changeset.diff"), join(ws, changeset));
const result = spawnSync(process.execPath, [join(process.cwd(), "stub/reviewer.mjs"), readFileSync(join(input, "prompt.txt"), "utf8")], { cwd: ws, encoding: "utf8" });
process.stdout.write(result.stdout);
`;

function sh(cwd, command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity, ...extra },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}
const git = (cwd, ...args) => sh(cwd, "git", args);
const write = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

/** A repository with a base commit and a squashed slice commit for ticket 01 on top. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ralph-host-review-"));
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "core.autocrlf", "false");
  for (const script of [
    "ralph-debt.mjs",
    "ralph-host-review.mjs",
    "ralph-provider.mjs",
    "ralph-review-prompt.mjs",
    "ralph-review.mjs",
  ]) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(join(source, "scripts", script), join(dir, "scripts", script));
  }
  write(
    dir,
    "skills/code-review/report.schema.json",
    readFileSync(join(source, "skills/code-review/report.schema.json"), "utf8"),
  );
  write(
    dir,
    "stub/reviewer.mjs",
    readFileSync(join(source, "scripts/ralph-stub-reviewer.mjs"), "utf8"),
  );
  write(dir, "stub/host-reviewer.mjs", REVIEWER);
  write(dir, ".gitignore", ".ralph/\n");
  write(
    dir,
    "docs/technical-debt.md",
    "# Technical Debt Register\n\n<!-- ralph-debt:begin -->\n<!-- ralph-debt:end -->\n",
  );
  sh(dir, process.execPath, ["scripts/ralph-debt.mjs", "format", "docs/technical-debt.md"]);
  write(
    dir,
    "issues/01-demo.md",
    "# 01: Demo\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] works\n",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  const base = git(dir, "rev-parse", "HEAD");
  write(dir, "feature.txt", "done\n");
  git(dir, "mv", "issues/01-demo.md", "issues/01-done.md");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "feat(slice-01): Demo");
  return { dir, base, slice: git(dir, "rev-parse", "HEAD") };
}

/** Runs hostReview in `dir`; returns its result and what the reviewers recorded. */
function review({ dir, base, slice }, env = {}) {
  const log = join(dir, ".ralph", "reviewers.log");
  mkdirSync(dirname(log), { recursive: true });
  const call = `
    import { hostReview } from "./scripts/ralph-host-review.mjs";
    const result = hostReview(${JSON.stringify({
      base,
      slice,
      ticket: "issues/01-done.md",
      logDir: join(dir, ".ralph", "host-review", "r", "01-demo"),
      workDir: join(dir, ".ralph", "sandbox", "review-r"),
      label: "r",
    })});
    process.stdout.write(JSON.stringify(result));
  `;
  const out = sh(dir, process.execPath, ["--input-type=module", "-e", call], {
    RALPH_HOST_REVIEWER: "node stub/host-reviewer.mjs",
    RALPH_PROVIDER_BACKOFF: "0",
    STUB_LOG: log,
    ...env,
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result: JSON.parse(out), calls };
}

describe("ralph-host-review", () => {
  it("gives each reviewer only the host's inputs and a snapshot of exactly the candidate", () => {
    const candidate = repo();
    const { result, calls } = review(candidate);
    assert.equal(result.verdict, "approved");
    assert.deepEqual(calls.map((call) => call.axis).sort(), ["spec", "standards"]);
    for (const call of calls) {
      assert.deepEqual(call.files, [
        "changeset.diff",
        "changeset.path",
        "prompt.txt",
        "repo.bundle",
        "schema.json",
      ]);
      assert.equal(call.commit, candidate.slice);
      // One ref, at the candidate: nothing else of the host's repository goes in.
      assert.equal(call.heads, `${candidate.slice} refs/ralph/review/r`);
    }
    assert.equal(
      git(candidate.dir, "for-each-ref", "refs/ralph/"),
      "",
      "the bundle ref is removed",
    );
    assert.equal(existsSync(join(candidate.dir, ".ralph", "sandbox", "review-r")), false);
  });

  it("makes a new token for every review, so no earlier or planted report can match", () => {
    const candidate = repo();
    const first = review(candidate).result;
    const second = review(candidate).result;
    assert.equal(first.verdict, "approved");
    assert.equal(second.verdict, "approved");
    assert.notEqual(first.decision.token, second.decision.token);
    assert.match(first.decision.token, /^[0-9a-f]{16}$/);
  });

  it("judges the reports against the candidate's own range and files", () => {
    const candidate = repo();
    const { result } = review(candidate);
    assert.equal(result.decision.base, candidate.base);
    assert.equal(result.decision.head, candidate.slice);
    // The archive is a rename: Git reports it, to the prompt and to the gate alike, by its new path.
    assert.deepEqual(result.decision.files.sort(), ["feature.txt", "issues/01-done.md"]);
  });

  it("retries a reviewer the provider cut off in a fresh one, then judges", () => {
    const candidate = repo();
    const marker = join(candidate.dir, ".ralph", "failed-once");
    const { result, calls } = review(candidate, { STUB_FAIL_ONCE: marker });
    assert.equal(result.verdict, "approved");
    assert.equal(calls.length, 3, "the cut-off reviewer ran again");
  });

  it("is unavailable, never approved, when the provider keeps a reviewer from finishing", () => {
    const candidate = repo();
    const marker = join(candidate.dir, ".ralph", "failed-once");
    const { result } = review(candidate, { STUB_FAIL_ONCE: marker, RALPH_PROVIDER_RETRIES: "0" });
    assert.equal(result.verdict, "unavailable");
    assert.equal(readdirSync(join(candidate.dir, ".ralph", "sandbox")).length, 0);
  });
});
