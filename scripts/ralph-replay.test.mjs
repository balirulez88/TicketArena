// Scenario tests for scripts/ralph-replay.mjs (ADR 0018). Each builds a host repository holding a
// rejected candidate, an amended ticket on main, and the real importer (ralph-accept.mjs) with the
// same stubs scripts/ralph-accept.test.mjs uses for the Docker gate and the reviewer containers.
// The replay itself is real; only the RED container is a stub that records what it was asked to
// prove. Every refusal must leave main and the candidate exactly as they were.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
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
const UNTRUSTED = 3;
const BRANCH = "rejected/01-demo-20261108-102624";

const VERIFY = `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_VERIFY_LOG, process.argv.at(-1) + "\\n");
process.exit(Number(process.env.STUB_VERIFY_EXIT || 0));
`;
// Stands in for the RED container: records the commit and the test files it was given, and
// checks out the commit's test-only tree the way the container would see it.
const RED = `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [commit, ...tests] = process.argv.slice(2);
const names = spawnSync("git", ["diff", "--name-only", commit + "^", commit], { encoding: "utf8" }).stdout.trim();
appendFileSync(process.env.STUB_RED_LOG, JSON.stringify({ commit, tests, names: names.split("\\n") }) + "\\n");
process.exit(Number(process.env.STUB_RED_EXIT || 0));
`;
const HOST_REVIEWER = `
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const input = process.argv.at(-1);
const commit = process.env.RALPH_REVIEW_COMMIT;
const ws = mkdtempSync(join(tmpdir(), "ralph-review-ws-"));
const git = (...args) => spawnSync("git", args, { cwd: ws, encoding: "utf8" });
git("init", "--quiet", ".");
git("fetch", "--quiet", "--no-tags", join(input, "repo.bundle"), "+refs/*:refs/bundle/*");
git("-c", "advice.detachedHead=false", "checkout", "--quiet", commit);
const changeset = readFileSync(join(input, "changeset.path"), "utf8");
mkdirSync(dirname(join(ws, changeset)), { recursive: true });
copyFileSync(join(input, "changeset.diff"), join(ws, changeset));
appendFileSync(process.env.STUB_HOST_REVIEW_LOG, process.env.RALPH_REVIEW_AXIS + " " + commit + "\\n");
const result = spawnSync(process.execPath, [join(process.cwd(), "stub/reviewer.mjs"), readFileSync(join(input, "prompt.txt"), "utf8")], {
  cwd: ws,
  encoding: "utf8",
  env: { ...process.env, STUB_REVIEW: "clean" },
});
process.stdout.write(result.stdout);
process.exit(result.status ?? 1);
`;
const REGISTER =
  "# Technical Debt Register\n\n<!-- ralph-debt:begin -->\n<!-- ralph-debt:end -->\n";
const DEMO = `# 01: Demo ticket

**What to build:** a demo.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] works
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

/** A host with the importer, the replay tool, a candidate on a quarantine branch and an amended ticket. */
function scenario({ candidate: change, amend = true } = {}) {
  const host = mkdtempSync(join(tmpdir(), "ralph-replay-"));
  git(host, "init", "--quiet", "--initial-branch=main");
  git(host, "config", "core.autocrlf", "false");
  for (const script of [
    "ralph-accept.mjs",
    "ralph-artifacts.mjs",
    "ralph-debt.mjs",
    "ralph-host-review.mjs",
    "ralph-provider.mjs",
    "ralph-replay.mjs",
    "ralph-review-prompt.mjs",
    "ralph-review.mjs",
    "ralph-toolchain.mjs",
  ]) {
    mkdirSync(join(host, "scripts"), { recursive: true });
    copyFileSync(join(source, "scripts", script), join(host, "scripts", script));
  }
  write(
    host,
    "skills/code-review/report.schema.json",
    readFileSync(join(source, "skills/code-review/report.schema.json"), "utf8"),
  );
  mkdirSync(join(host, "node_modules"), { recursive: true });
  symlinkSync(join(source, "node_modules", "yaml"), join(host, "node_modules", "yaml"), "junction");
  write(host, "docs/technical-debt.md", REGISTER);
  write(host, "stub/host-reviewer.mjs", HOST_REVIEWER);
  write(
    host,
    "stub/reviewer.mjs",
    readFileSync(join(source, "scripts", "ralph-stub-reviewer.mjs"), "utf8"),
  );
  write(host, "stub/verify.mjs", VERIFY);
  write(host, "stub/red.mjs", RED);
  write(host, "scripts/ralph-ci.sh", "exit 0\n");
  write(host, ".github/workflows/ci.yml", "name: CI\n");
  write(host, "package.json", '{"scripts":{"test":"vitest"},"devDependencies":{}}\n');
  write(host, "packages/demo/package.json", '{"scripts":{"test":"vitest run","dev":"x"}}\n');
  write(host, "issues/01-demo.md", DEMO);
  write(host, "app.txt", "v1\n");
  write(host, ".gitignore", ".ralph/\nnode_modules/\n.env\n.env.*\nsecrets/\n");
  sh(host, process.execPath, ["scripts/ralph-debt.mjs", "format", "docs/technical-debt.md"]);
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "init");
  const origin = git(host, "rev-parse", "main");

  // The candidate, as the importer's review rejection keeps it: one slice commit on the base.
  git(host, "switch", "--quiet", "-c", BRANCH);
  write(host, "packages/demo/feature.ts", "export const feature = 1;\n");
  write(host, "packages/demo/feature.test.ts", "test('feature', () => {});\n");
  change?.(host);
  git(host, "rm", "--quiet", "issues/01-demo.md");
  write(
    host,
    "issues/done/01-demo.md",
    DEMO.replace(
      "**Status:** ready-for-agent",
      "**Status:** done\n\n**Completed:** 2026-11-08 by slice/01-demo (run 20261108-102624)",
    ).replace("- [ ] works", "- [x] works"),
  );
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "feat(slice-01): Demo ticket");
  const tip = git(host, "rev-parse", "HEAD");
  git(host, "switch", "--quiet", "main");

  // A human then amended the ticket on main; it is ready again.
  if (amend) {
    write(host, "issues/01-demo.md", `${DEMO}- [ ] the amended criterion\n`);
    git(host, "commit", "--quiet", "-am", "chore(issues): amend ticket 01");
  }
  return { host, origin, tip };
}

function replay(host, tip, { red = 0, verify = 0, accept = true, expect = tip, extra = [] } = {}) {
  const verifyLog = join(host, ".ralph", "verify.log");
  mkdirSync(dirname(verifyLog), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/ralph-replay.mjs",
      "--candidate",
      BRANCH,
      "--expect",
      expect,
      ...(accept ? ["--accept"] : []),
      ...extra,
    ],
    {
      cwd: host,
      encoding: "utf8",
      env: {
        ...process.env,
        ...identity,
        RALPH_BASE_BRANCH: "main",
        RALPH_REPLAY_RED: "node stub/red.mjs",
        STUB_RED_LOG: join(host, ".ralph", "red.log"),
        STUB_RED_EXIT: String(red),
        RALPH_ACCEPT_VERIFY: "node stub/verify.mjs",
        STUB_VERIFY_LOG: verifyLog,
        STUB_VERIFY_EXIT: String(verify),
        RALPH_HOST_REVIEWER: "node stub/host-reviewer.mjs",
        STUB_HOST_REVIEW_LOG: join(host, ".ralph", "host-review.log"),
        RALPH_PROVIDER_RETRIES: "0",
      },
    },
  );
  const lines = (name) => {
    const file = join(host, ".ralph", name);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  return {
    code: result.status,
    output: result.stderr,
    red: lines("red.log").map((line) => JSON.parse(line)),
    verified: lines("verify.log"),
    reviewed: lines("host-review.log"),
  };
}

const heads = (host) =>
  git(host, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
const runs = (host) => {
  const dir = join(host, ".ralph", "sandbox");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("replay-")) : [];
};

describe("ralph-replay", () => {
  it("replays the exact implementation on the amended base through the full importer", () => {
    const { host, tip } = scenario();
    const before = heads(host);
    const result = replay(host, tip);
    assert.equal(result.code, 0, result.output);

    // RED was re-proved on a tree holding only the candidate's test file, on the new base.
    assert.equal(result.red.length, 1);
    assert.deepEqual(result.red[0].tests, ["packages/demo/feature.test.ts"]);
    assert.deepEqual(result.red[0].names, ["packages/demo/feature.test.ts"]);

    // The importer ran everything: the hardened gate on the merge, and two fresh reviewers.
    const merge = git(host, "rev-parse", "main");
    assert.equal(git(host, "log", "-1", "--format=%s", "main"), "Merge slice/01-demo: Demo ticket");
    assert.deepEqual(result.verified, [merge]);
    assert.equal(result.reviewed.length, 2);
    assert.ok(
      result.reviewed.every((line) => line.endsWith(` ${git(host, "rev-parse", "main^2")}`)),
    );

    // The implementation is the candidate's, byte for byte; the ticket is the amended one.
    for (const path of ["packages/demo/feature.ts", "packages/demo/feature.test.ts"]) {
      assert.equal(
        git(host, "rev-parse", `main:${path}`),
        git(host, "rev-parse", `${tip}:${path}`),
      );
    }
    const archived = git(host, "show", "main:issues/done/01-demo.md");
    assert.match(archived, /the amended criterion/);
    assert.match(archived, /\*\*Status:\*\* done/);
    assert.equal(existsSync(join(host, "issues", "01-demo.md")), false);

    // The candidate is immutable, and the new history is on main only.
    assert.equal(git(host, "rev-parse", BRANCH), tip);
    assert.notEqual(before, heads(host));
    assert.equal(runs(host).length, 0);
  });

  it("prepares without importing when --accept is not given", () => {
    const { host, tip } = scenario();
    const main = git(host, "rev-parse", "main");
    const result = replay(host, tip, { accept: false });
    assert.equal(result.code, 0, result.output);
    assert.equal(git(host, "rev-parse", "main"), main);
    assert.equal(result.verified.length + result.reviewed.length, 0);
    assert.equal(runs(host).length, 1);
    assert.match(result.output, /ralph-accept\.mjs/);
  });

  it("refuses a candidate that is no longer the pinned commit", () => {
    const { host, tip } = scenario();
    git(host, "switch", "--quiet", BRANCH);
    write(host, "packages/demo/feature.ts", "export const feature = 2; // tampered\n");
    git(host, "commit", "--quiet", "-am", "wip: tamper");
    git(host, "switch", "--quiet", "main");
    const before = heads(host);
    const result = replay(host, tip);
    assert.equal(result.code, 1);
    assert.match(result.output, /not the one you pinned/);
    assert.equal(heads(host), before);
    assert.equal(result.red.length + result.verified.length, 0);
    assert.equal(runs(host).length, 0);
  });

  it("refuses a tampered candidate even when its new tip is pinned", () => {
    const { host, tip } = scenario();
    git(host, "switch", "--quiet", BRANCH);
    write(host, "packages/demo/feature.ts", "export const feature = 2;\n");
    git(host, "commit", "--quiet", "-am", "wip: more");
    const moved = git(host, "rev-parse", "HEAD");
    git(host, "switch", "--quiet", "main");
    const result = replay(host, tip, { expect: moved });
    assert.equal(result.code, 1);
    assert.match(result.output, /own base .* is not part of main|not a slice commit/);
    assert.equal(result.red.length, 0);
  });

  it("refuses a base that changed an implementation file since the candidate's own base", () => {
    const { host, tip } = scenario({
      candidate: (dir) => write(dir, "app.txt", "v2 from the candidate\n"),
    });
    write(host, "app.txt", "v1 changed on main since\n");
    git(host, "commit", "--quiet", "-am", "fix: app on main");
    const before = heads(host);
    const result = replay(host, tip);
    assert.equal(result.code, 1);
    assert.match(result.output, /incorrect base: app\.txt/);
    assert.equal(heads(host), before);
    assert.equal(result.red.length + result.verified.length + result.reviewed.length, 0);
    assert.equal(runs(host).length, 0);
  });

  it("does not turn a blocked ticket into a merge", () => {
    const { host, tip } = scenario({ amend: false });
    write(host, "issues/01-demo.md", DEMO.replace("ready-for-agent", "blocked"));
    git(host, "commit", "--quiet", "-am", "chore(issues): block 01");
    const before = heads(host);
    const result = replay(host, tip);
    assert.equal(result.code, 1);
    assert.match(result.output, /must be ready-for-agent/);
    assert.equal(heads(host), before);
    assert.equal(result.red.length, 0);
  });

  it("does not import when RED is not proven on the new base", () => {
    const { host, tip } = scenario();
    const before = heads(host);
    const result = replay(host, tip, { red: 1 });
    assert.equal(result.code, 1);
    assert.match(result.output, /RED is NOT proven/);
    assert.equal(result.red.length, 1);
    assert.equal(result.verified.length + result.reviewed.length, 0);
    assert.equal(heads(host), before);
    assert.equal(runs(host).length, 0);
  });

  it("leaves protected paths to the importer, which refuses them untouched", () => {
    const { host, tip } = scenario({
      candidate: (dir) => write(dir, "scripts/evil.mjs", "process.exit(0);\n"),
    });
    const before = heads(host);
    const result = replay(host, tip);
    assert.equal(result.code, UNTRUSTED, result.output);
    assert.match(result.output, /REFUSED/);
    assert.equal(heads(host), before);
    assert.equal(result.reviewed.length, 0);
    assert.equal(git(host, "rev-parse", BRANCH), tip);
  });

  it("does not accept a gate that fails on the replayed merge", () => {
    const { host, tip } = scenario();
    const before = heads(host);
    const result = replay(host, tip, { verify: 1 });
    assert.equal(result.code, UNTRUSTED, result.output);
    assert.equal(heads(host), before);
    assert.equal(result.reviewed.length, 0);
  });

  it("refuses to run away from a clean base checkout", () => {
    const { host, tip } = scenario();
    write(host, "app.txt", "uncommitted\n");
    const result = replay(host, tip, { accept: false });
    assert.equal(result.code, 1);
    assert.match(result.output, /working tree is not clean/);
  });
});
