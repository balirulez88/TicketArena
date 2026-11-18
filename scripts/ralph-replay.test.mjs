// Scenario tests for scripts/ralph-replay.mjs (ADR 0018). Each builds a host repository holding a
// rejected candidate, an amended ticket on main, and the real importer (ralph-accept.mjs) with the
// same stubs scripts/ralph-accept.test.mjs uses for the Docker gate and the reviewer containers.
// The replay itself is real; only the RED container is a stub that records what it was asked to
// prove. Every refusal must leave main and the candidate exactly as they were.

import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
const SUFFIX = "01-demo-20261108-102624";
const BRANCH = `rejected/${SUFFIX}`;
const NEW = `refs/ralph/rejected/${SUFFIX}`;
const LEGACY = `refs/heads/rejected/${SUFFIX}`;
// Where each layout keeps the candidate, and the name the host's record gives it:
//   quarantine  the importer since TD-059 WS1
//   legacy      the importer before it: an ordinary branch, recorded by its short name
//   migrated    a legacy candidate the maintainer moved to the new namespace (D1)
const LAYOUTS = {
  quarantine: { ref: NEW, recorded: NEW },
  legacy: { ref: LEGACY, recorded: BRANCH },
  migrated: { ref: NEW, recorded: BRANCH },
};

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
  env: { ...process.env, STUB_REVIEW: process.env.STUB_HOST_REVIEW || "clean" },
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
function scenario({
  candidate: change,
  staged,
  amend = true,
  recorded = true,
  layout = "quarantine",
} = {}) {
  const { ref, recorded: recordedAs } = LAYOUTS[layout];
  const host = mkdtempSync(join(tmpdir(), "ralph-replay-"));
  git(host, "init", "--quiet", "--initial-branch=main");
  git(host, "config", "core.autocrlf", "false");
  for (const script of [
    "ralph-accept.mjs",
    "ralph-artifacts.mjs",
    "ralph-debt.mjs",
    "ralph-host-review.mjs",
    "ralph-provider.mjs",
    "ralph-push-inspect.mjs",
    "ralph-quarantine.mjs",
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
  git(host, "switch", "--quiet", "-c", "work");
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
  staged?.(host);
  git(host, "commit", "--quiet", "-m", "feat(slice-01): Demo ticket");
  const tip = git(host, "rev-parse", "HEAD");
  git(host, "switch", "--quiet", "main");
  git(host, "branch", "--quiet", "-D", "work");
  git(host, "update-ref", ref, tip);

  // The importer's record of the host review's rejection, the one commit only it can write.
  if (recorded) {
    record(host, tip, recordedAs);
  }

  // A human then amended the ticket on main; it is ready again.
  if (amend) {
    write(host, "issues/01-demo.md", `${DEMO}- [ ] the amended criterion\n`);
    git(host, "commit", "--quiet", "-am", "chore(issues): amend ticket 01");
  }
  return { host, origin, tip, ref };
}

/** The host's record of a review rejection, worded exactly as ralph-accept.mjs writes it. */
function record(host, tip, where) {
  write(host, "issues/01-demo.md", DEMO.replace("ready-for-agent", "blocked"));
  git(
    host,
    "commit",
    "--quiet",
    "-am",
    "chore(issues): block issues/01-demo.md after the host review",
    "-m",
    `The host's isolated Standards and Spec review of slice/01-demo (${tip.slice(0, 12)}) was blocked, so the slice did not merge. It is preserved on ${where}. Report: .ralph/host-review/20261108-102624-1/01-demo/review.md`,
  );
}

/** A commit on top of the candidate, and the candidate ref moved to it. */
function tamper(host, ref) {
  const tree = git(host, "rev-parse", "main^{tree}");
  const moved = git(host, "commit-tree", tree, "-p", git(host, "rev-parse", ref), "-m", "wip");
  git(host, "update-ref", ref, moved);
  return moved;
}

function replay(
  host,
  tip,
  {
    red = 0,
    verify = 0,
    accept = true,
    expect = tip,
    extra = [],
    review = "clean",
    candidate = NEW,
  } = {},
) {
  const verifyLog = join(host, ".ralph", "verify.log");
  mkdirSync(dirname(verifyLog), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/ralph-replay.mjs",
      "--candidate",
      candidate,
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
        STUB_HOST_REVIEW: review,
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

// Every ref, quarantine and incoming included: a refusal must leave all of them as they were.
const heads = (host) => git(host, "for-each-ref", "--format=%(refname) %(objectname)");
// A refused import keeps the run's incoming refs for a human (ralph-accept.mjs): everything
// else must be as it was.
const incoming = (host) => git(host, "for-each-ref", "refs/ralph/incoming/");
const settled = (host) =>
  heads(host)
    .split("\n")
    .filter((line) => !line.startsWith("refs/ralph/incoming/"))
    .join("\n");
// Private refs the replay made for its one fetch must never outlive it.
const leaked = (host) => git(host, "for-each-ref", "refs/ralph/replay/");
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
    assert.equal(git(host, "rev-parse", NEW), tip);
    assert.notEqual(before, heads(host));
    assert.equal(runs(host).length, 0);
    assert.equal(leaked(host), "");
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
    tamper(host, NEW);
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
    const moved = tamper(host, NEW);
    const result = replay(host, tip, { expect: moved });
    assert.equal(result.code, 1);
    assert.match(result.output, /no host-review rejection|own base .* is not part of main/);
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
    assert.equal(leaked(host), "");
  });

  it("leaves protected paths to the importer, which refuses them untouched", () => {
    const { host, tip } = scenario({
      candidate: (dir) => write(dir, "scripts/evil.mjs", "process.exit(0);\n"),
    });
    const before = settled(host);
    const result = replay(host, tip);
    assert.equal(result.code, UNTRUSTED, result.output);
    assert.match(result.output, /REFUSED/);
    assert.equal(settled(host), before);
    assert.notEqual(incoming(host), "", "the importer keeps the refused run for a human");
    assert.equal(result.reviewed.length, 0);
    assert.equal(git(host, "rev-parse", NEW), tip);
  });

  it("does not accept a gate that fails on the replayed merge", () => {
    const { host, tip } = scenario();
    const before = settled(host);
    const result = replay(host, tip, { verify: 1 });
    assert.equal(result.code, UNTRUSTED, result.output);
    assert.equal(result.red.length, 1, "RED ran before the importer");
    assert.equal(settled(host), before);
    assert.notEqual(incoming(host), "", "the importer keeps the refused run for a human");
    assert.equal(result.reviewed.length, 0);
  });

  it("refuses a quarantine branch the host review never rejected", () => {
    const { host, tip } = scenario({ recorded: false });
    const before = heads(host);
    const result = replay(host, tip);
    assert.equal(result.code, 1);
    assert.match(result.output, /no host-review rejection of .* is recorded/);
    assert.equal(heads(host), before);
    assert.equal(result.red.length, 0);
  });

  it("refuses a record that names another commit of the same branch", () => {
    const { host, tip } = scenario({ recorded: false });
    record(host, "0".repeat(40), NEW);
    const result = replay(host, tip);
    assert.equal(result.code, 1);
    assert.match(result.output, /no host-review rejection/);
  });

  it("reproduces a deletion exactly in the bundle it prepares", () => {
    const { host, tip } = scenario({ candidate: (dir) => rmSync(join(dir, "app.txt")) });
    const result = replay(host, tip, { accept: false });
    assert.equal(result.code, 0, result.output);
    const [run] = runs(host);
    const bundle = join(host, ".ralph", "sandbox", run, "out", "result.bundle");
    git(host, "fetch", "--quiet", bundle, "refs/heads/main:refs/heads/probe");
    assert.throws(() => git(host, "cat-file", "-e", "probe:app.txt"));
    assert.equal(
      git(host, "rev-parse", "probe:packages/demo/feature.ts"),
      git(host, "rev-parse", `${tip}:packages/demo/feature.ts`),
    );
    assert.equal(git(host, "rev-parse", "probe^2^"), git(host, "rev-parse", "main"));
  });

  it("keeps a host review that blocks the replay as blocking", () => {
    const { host, tip } = scenario();
    const result = replay(host, tip, { review: "high" });
    assert.equal(result.code, 1, result.output);
    assert.equal(result.reviewed.length >= 1, true);
    assert.match(git(host, "show", "main:issues/01-demo.md"), /\*\*Status:\*\* blocked/);
    assert.equal(git(host, "rev-parse", NEW), tip);
    assert.equal(leaked(host), "");
  });

  const refusals = [
    [
      "a symlink",
      /symlink or submodule/,
      null,
      (dir) => {
        const target = git(dir, "hash-object", "-w", "app.txt");
        git(dir, "update-index", "--add", "--cacheinfo", `120000,${target},packages/demo/link`);
      },
    ],
    [
      "a submodule",
      /symlink or submodule/,
      null,
      (dir) =>
        git(
          dir,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${"1".repeat(40)},packages/demo/sub`,
        ),
    ],
    [
      "a second ticket file",
      /may only archive its own ticket/,
      (dir) => write(dir, "issues/02-other.md", "x\n"),
    ],
    ["an option-like path", /will not carry/, (dir) => write(dir, "-evil/x.ts", "x\n")],
    ["a non-ASCII path", /will not carry/, (dir) => write(dir, "packages/demo/café.ts", "x\n")],
    ["no test file", /no test file/, (dir) => rmSync(join(dir, "packages/demo/feature.test.ts"))],
  ];
  for (const [name, message, ...hooks] of refusals) {
    it(`refuses a candidate with ${name}`, () => {
      // Three-element rows give the working-tree change; four-element rows a staged-only one.
      const [change, staged] = hooks.length === 2 ? hooks : [hooks[0], undefined];
      const { host, tip } = scenario({ candidate: change ?? undefined, staged });
      const before = heads(host);
      const result = replay(host, tip);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, message);
      assert.equal(heads(host), before);
      assert.equal(result.verified.length + result.reviewed.length, 0);
      assert.equal(runs(host).length, 0);
      assert.equal(leaked(host), "");
    });
  }

  it("refuses when the ticket's amended title no longer matches the slice subject", () => {
    const { host, tip } = scenario();
    write(host, "issues/01-demo.md", `${DEMO.replace("Demo ticket", "Renamed ticket")}- [ ] x\n`);
    git(host, "commit", "--quiet", "-am", "chore(issues): rename");
    const result = replay(host, tip);
    assert.equal(result.code, 1);
    assert.match(result.output, /is not "feat\(slice-01\): Renamed ticket"/);
  });

  it("refuses to run away from a clean base checkout", () => {
    const { host, tip } = scenario();
    write(host, "app.txt", "uncommitted\n");
    const result = replay(host, tip, { accept: false });
    assert.equal(result.code, 1);
    assert.match(result.output, /working tree is not clean/);
  });
});

// --- TD-059 WS2: where a candidate may come from ---------------------------------------------------

describe("ralph-replay: quarantine namespaces (TD-059)", () => {
  /** Replays successfully: the exact implementation merged, the candidate untouched. */
  function assertReplayed(host, tip, ref, result) {
    assert.equal(result.code, 0, result.output);
    assert.equal(git(host, "log", "-1", "--format=%s", "main"), "Merge slice/01-demo: Demo ticket");
    assert.equal(
      git(host, "rev-parse", "main:packages/demo/feature.ts"),
      git(host, "rev-parse", `${tip}:packages/demo/feature.ts`),
    );
    assert.equal(git(host, "rev-parse", ref), tip, "the candidate ref is never written");
    assert.equal(leaked(host), "");
  }

  /** Refused before RED: nothing ran, no ref moved, no run directory. */
  function assertRefusedEarly(host, before, result, pattern) {
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /REFUSED/);
    assert.match(result.output, pattern);
    assert.equal(heads(host), before);
    assert.equal(result.red.length + result.verified.length + result.reviewed.length, 0);
    assert.equal(runs(host).length, 0);
  }

  it("replays a candidate from refs/ralph/rejected/ by its full name", () => {
    const { host, tip } = scenario();
    assertReplayed(host, tip, NEW, replay(host, tip, { candidate: NEW }));
  });

  it("replays a legacy refs/heads/rejected/ branch with its legacy record", () => {
    const { host, tip } = scenario({ layout: "legacy" });
    assertReplayed(host, tip, LEGACY, replay(host, tip, { candidate: LEGACY }));
  });

  it("takes the alias rejected/<name> for the candidate in either namespace", () => {
    const { host, tip } = scenario({ layout: "legacy" });
    assertReplayed(host, tip, LEGACY, replay(host, tip, { candidate: BRANCH }));
  });

  it("replays a migrated candidate under its legacy record (D1), and says so", () => {
    const { host, tip } = scenario({ layout: "migrated" });
    const result = replay(host, tip, { candidate: NEW });
    assertReplayed(host, tip, NEW, result);
    assert.match(result.output, /covered by the legacy record rejected\/01-demo-20261108-102624/);
  });

  it("does not let a legacy record vouch for an unrelated migrated candidate (D1)", () => {
    const { host, tip } = scenario({ layout: "migrated" });
    // The same commit under another suffix: the record names 01-demo-20261108-102624 only.
    const other = "refs/ralph/rejected/01-demo-20261109-090000";
    git(host, "update-ref", other, tip);
    git(host, "update-ref", "-d", NEW);
    const before = heads(host);
    assertRefusedEarly(host, before, replay(host, tip, { candidate: other }), /no host-review/);
  });

  it("does not let a current record vouch for a branch under refs/heads/", () => {
    const { host, tip } = scenario();
    git(host, "update-ref", "-d", NEW);
    git(host, "update-ref", LEGACY, tip);
    const before = heads(host);
    assertRefusedEarly(host, before, replay(host, tip, { candidate: LEGACY }), /no host-review/);
  });

  it("refuses conflicting candidates in the two namespaces", () => {
    const { host, tip } = scenario();
    git(host, "update-ref", LEGACY, git(host, "rev-parse", "main~1"));
    const before = heads(host);
    for (const candidate of [NEW, LEGACY, BRANCH]) {
      assertRefusedEarly(host, before, replay(host, tip, { candidate }), /conflicting/);
    }
  });

  for (const [what, candidate, pattern] of [
    ["an incoming ref", `refs/ralph/incoming/20261108-102624-1/rejected/${SUFFIX}`, /incoming/],
    ["a published remote-tracking copy", `refs/remotes/origin/rejected/${SUFFIX}`, /published/],
    ["a branch outside quarantine", "refs/heads/feature", /not in a quarantine namespace/],
  ]) {
    it(`refuses ${what}, even at the recorded commit`, () => {
      const { host, tip } = scenario();
      git(host, "update-ref", candidate, tip);
      const before = heads(host);
      assertRefusedEarly(host, before, replay(host, tip, { candidate }), pattern);
    });
  }

  for (const [what, candidate, pattern] of [
    ["a missing candidate", "refs/ralph/rejected/01-demo-20261231-235959", /no quarantine ref/],
    ["a malformed name", "rejected/01-demo", /not a valid quarantine name/],
    ["a name with a path trick", `rejected/../${SUFFIX}`, /not a valid quarantine name/],
  ]) {
    it(`refuses ${what}`, () => {
      const { host, tip } = scenario();
      const before = heads(host);
      assertRefusedEarly(host, before, replay(host, tip, { candidate }), pattern);
    });
  }

  it("refuses a symbolic candidate ref", () => {
    const { host, tip } = scenario();
    git(host, "update-ref", "-d", NEW);
    git(host, "update-ref", "refs/heads/keep", tip);
    git(host, "symbolic-ref", NEW, "refs/heads/keep");
    const before = heads(host);
    assertRefusedEarly(host, before, replay(host, tip), /symbolic/);
  });

  it("never guesses a short name: a tag of the alias's name is not the candidate", () => {
    const { host, tip } = scenario();
    git(host, "update-ref", "-d", NEW);
    git(host, "update-ref", `refs/tags/${BRANCH}`, tip);
    const before = heads(host);
    assertRefusedEarly(host, before, replay(host, tip, { candidate: BRANCH }), /no quarantine/);
  });

  it("refuses a candidate pinned by an abbreviated commit", () => {
    const { host, tip } = scenario();
    const before = heads(host);
    const result = replay(host, tip, { expect: tip.slice(0, 12) });
    assertRefusedEarly(host, before, result, /full 40-character commit/);
  });

  it("refuses a migrated candidate whose legacy record names another commit", () => {
    const { host, tip } = scenario({ layout: "migrated", recorded: false });
    record(host, "0".repeat(40), BRANCH);
    const before = heads(host);
    assertRefusedEarly(host, before, replay(host, tip), /no host-review/);
  });

  it("does not import a migrated candidate when RED is not proven", () => {
    const { host, tip } = scenario({ layout: "migrated" });
    const before = heads(host);
    const result = replay(host, tip, { red: 1 });
    assert.equal(result.code, 1);
    assert.match(result.output, /RED is NOT proven/);
    assert.equal(heads(host), before);
    assert.equal(result.verified.length + result.reviewed.length, 0);
  });

  it("leaves a migrated candidate's protected path to the importer, which refuses it", () => {
    const { host, tip } = scenario({
      layout: "migrated",
      candidate: (dir) => write(dir, "scripts/evil.mjs", "process.exit(0);\n"),
    });
    const before = settled(host);
    const result = replay(host, tip);
    assert.equal(result.code, UNTRUSTED, result.output);
    assert.equal(settled(host), before);
    assert.notEqual(incoming(host), "", "the importer keeps the refused run for a human");
    assert.equal(git(host, "rev-parse", NEW), tip);
  });

  it("removes only its own scratch refs, never another ref under refs/ralph/", () => {
    const { host, tip } = scenario();
    const main = git(host, "rev-parse", "main");
    git(host, "update-ref", "refs/ralph/replay/someone-else/main", main);
    git(host, "update-ref", `refs/ralph/incoming/20261108-102624-1/rejected/${SUFFIX}`, tip);
    const result = replay(host, tip, { accept: false });
    assert.equal(result.code, 0, result.output);
    assert.equal(leaked(host), `${main} commit\trefs/ralph/replay/someone-else/main`);
    assert.equal(
      git(host, "rev-parse", `refs/ralph/incoming/20261108-102624-1/rejected/${SUFFIX}`),
      tip,
    );
    assert.equal(git(host, "rev-parse", NEW), tip);
  });
});
