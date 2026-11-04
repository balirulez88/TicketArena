// Scenario tests for scripts/ralph-accept.mjs, the host's acceptance of a sandbox run (ADR 0014).
// Each test builds a host repository and a "container" clone of it. In the clone it produces what
// a run leaves behind (a Ralph-shaped merge, rejection or pause), or a forgery of one. Then it
// bundles the clone's branches into the run's out/ directory, as sandbox-entrypoint.sh does.
// The real importer runs on the host with a stub in place of the agent-free verify sandbox.
// Every refusal must leave the host repository exactly as it was.

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
import { basename, dirname, join } from "node:path";
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
const PAUSED = 75;

const VERIFY = `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_VERIFY_LOG, process.argv.at(-1) + "\\n");
process.exit(Number(process.env.STUB_VERIFY_EXIT || 0));
`;

const DEMO = `# 01: Demo ticket

**What to build:** a demo.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] works
`;
const NEXT = DEMO.replace("# 01: Demo ticket", "# 02: Next ticket").replace(
  "None (can start immediately)",
  "01",
);

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
// Stages a file by name alone, past the working tree. A container on Linux can commit both
// `Scripts/x` and `scripts/x`, or `scripts./x`, which a Windows checkout cannot even hold.
const stage = (dir, path, text) => {
  const file = join(mkdtempSync(join(tmpdir(), "ralph-blob-")), "blob");
  writeFileSync(file, text);
  const blob = git(dir, "hash-object", "-w", file);
  git(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
};

function hostRepo() {
  const host = mkdtempSync(join(tmpdir(), "ralph-accept-"));
  git(host, "init", "--quiet", "--initial-branch=main");
  git(host, "config", "core.autocrlf", "false");
  for (const script of ["ralph-accept.mjs", "ralph-artifacts.mjs"]) {
    mkdirSync(join(host, "scripts"), { recursive: true });
    copyFileSync(join(source, "scripts", script), join(host, "scripts", script));
  }
  write(host, "scripts/ralph-ci.sh", "exit 0\n");
  write(host, ".github/workflows/ci.yml", "name: CI\n");
  write(host, "package.json", '{"scripts":{"test":"vitest"},"devDependencies":{}}\n');
  write(host, "packages/demo/package.json", '{"scripts":{"test":"vitest run","dev":"x"}}\n');
  write(host, "issues/01-demo.md", DEMO);
  write(host, "issues/02-next.md", NEXT);
  write(host, "app.txt", "v1\n");
  write(host, ".gitignore", ".ralph/\n");
  write(host, "stub/verify.mjs", VERIFY);
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "init");
  return host;
}

/** A clone standing in for the container's workspace, which pushes to its staging repository. */
function container(host) {
  const ws = mkdtempSync(join(tmpdir(), "ralph-accept-ws-"));
  git(ws, "clone", "--quiet", "--config", "core.autocrlf=false", host, ".");
  git(ws, "config", "core.autocrlf", "false");
  // Lets the clone stage names Windows would refuse, as a Linux container can.
  git(ws, "config", "core.protectNTFS", "false");
  return ws;
}

const RUN = "20261104-120000";

// What finalize_slice produces: one squashed commit on main with the ticket archived as done,
// merged --no-ff. `change` adds the slice's own work (and any forgery) before the commit.
function merge(ws, slug = "01-demo", { change, staged, title, subject } = {}) {
  const file = `issues/${slug}.md`;
  const text = readFileSync(join(ws, file), "utf8");
  const ticketTitle = title ?? /^# \d{2}: (.*)$/m.exec(text)[1];
  git(ws, "switch", "--quiet", "-c", `slice/${slug}`);
  write(ws, "feature.txt", "done\n");
  const archived = text
    .replace(
      /^\*\*Status:\*\* .*$/m,
      `**Status:** done\n\n**Completed:** 2026-11-04 by slice/${slug} (run ${RUN})`,
    )
    .replace("- [ ] works", "- [x] works");
  git(ws, "rm", "--quiet", file);
  write(ws, `issues/done/${slug}.md`, archived);
  change?.(ws);
  git(ws, "add", "-A");
  staged?.(ws);
  git(ws, "commit", "--quiet", "-m", subject ?? `feat(slice-${slug.slice(0, 2)}): ${ticketTitle}`);
  // The --no-ff merge, written without a checkout: main has not moved, so the merge's tree is the
  // slice's, and the clone keeps names its own file system could not hold (`stage`).
  const slice = git(ws, "rev-parse", "HEAD");
  const message = `Merge slice/${slug}: ${ticketTitle}`;
  const merged = git(
    ws,
    "commit-tree",
    `${slice}^{tree}`,
    "-p",
    "main",
    "-p",
    slice,
    "-m",
    message,
  );
  git(ws, "update-ref", "refs/heads/main", merged);
  git(ws, "symbolic-ref", "HEAD", "refs/heads/main");
  return { slice: git(ws, "rev-parse", `slice/${slug}`), merge: git(ws, "rev-parse", "main") };
}

// What reject_slice produces: the work on a quarantine branch, the status on main.
function reject(
  ws,
  slug = "01-demo",
  edit = (text) => text.replace(/^\*\*Status:\*\* .*$/m, "**Status:** blocked"),
) {
  git(ws, "switch", "--quiet", "-c", `rejected/${slug}-${RUN}`);
  write(ws, "half-done.txt", "wip\n");
  git(ws, "add", "-A");
  git(ws, "commit", "--quiet", "-m", "wip(ralph): rejected: review");
  git(ws, "switch", "--quiet", "main");
  const file = `issues/${slug}.md`;
  write(ws, file, edit(readFileSync(join(ws, file), "utf8")));
  git(ws, "commit", "--quiet", "-am", `chore(issues): block ${file} after rejected agent run`);
}

// What pause_ticket produces: the gated checkpoint, the interrupted work on top of it, parked.
function pause(ws, slug = "01-demo", { work } = {}) {
  const base = git(ws, "rev-parse", "main");
  git(ws, "switch", "--quiet", "-c", `slice/${slug}`);
  const file = `issues/${slug}.md`;
  write(ws, file, readFileSync(join(ws, file), "utf8").replace("ready-for-agent", "in-progress"));
  write(ws, "test.txt", "red\n");
  git(ws, "add", "-A");
  git(ws, "commit", "--quiet", "-m", "wip(ralph): green checkpoint");
  const gated = git(ws, "rev-parse", "HEAD");
  write(ws, "partial.txt", "half\n");
  work?.(ws);
  git(ws, "add", "-A");
  git(ws, "commit", "--quiet", "-m", "wip(ralph): paused in refactor (usage-limit)");
  git(ws, "branch", "--quiet", `ralph/paused/${slug}`, "HEAD");
  git(ws, "switch", "--quiet", "main");
  git(ws, "branch", "--quiet", "-D", `slice/${slug}`);
  const paused = git(ws, "rev-parse", `ralph/paused/${slug}`);
  const state = [
    `ticket=${slug.slice(0, 2)}`,
    `ref=ralph/paused/${slug}`,
    `base=${base}`,
    `gated=${gated}`,
    `paused=${paused}`,
    "phase=refactor",
    "attempt=2",
    "round=1",
    "reason=usage-limit",
    `run=${RUN}`,
  ];
  return { base, gated, paused, state: `${state.join("\n")}\n` };
}

/** The run directory as the container leaves it: its branches bundled, plus state and logs. */
function finish(host, ws, { state = {}, logs = true, name = "run1" } = {}) {
  const run = join(host, ".ralph", "sandbox", name);
  mkdirSync(join(run, "out", "state"), { recursive: true });
  git(ws, "bundle", "create", "--quiet", join(run, "out", "result.bundle"), "--branches");
  for (const [name, text] of Object.entries(state)) {
    writeFileSync(join(run, "out", "state", name), text);
  }
  if (logs) {
    write(join(run, "out"), `logs/${RUN}/01-demo.agent.log`, "agent output\n");
  }
  return run;
}

function accept(host, run, { base, exit = 0, ticket = "01", verify = 0 } = {}) {
  const verifyLog = join(host, ".ralph", "verify.log");
  mkdirSync(dirname(verifyLog), { recursive: true });
  const args = [
    "scripts/ralph-accept.mjs",
    "--run-dir",
    run,
    "--base",
    base,
    "--exit",
    String(exit),
  ];
  const result = spawnSync(process.execPath, ticket ? [...args, "--ticket", ticket] : args, {
    cwd: host,
    encoding: "utf8",
    env: {
      ...process.env,
      ...identity,
      RALPH_BASE_BRANCH: "main",
      RALPH_ACCEPT_VERIFY: "node stub/verify.mjs",
      STUB_VERIFY_LOG: verifyLog,
      STUB_VERIFY_EXIT: String(verify),
    },
  });
  const verified = existsSync(verifyLog)
    ? readFileSync(verifyLog, "utf8").split("\n").filter(Boolean)
    : [];
  return { code: result.status, output: result.stderr, verified };
}

const snapshot = (host) => ({
  refs: git(host, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"),
  head: git(host, "rev-parse", "HEAD"),
  status: git(host, "status", "--porcelain"),
  config: readFileSync(join(host, ".git", "config"), "utf8"),
  hooks: readdirSync(join(host, ".git", "hooks"))
    .sort()
    .join(","),
  state: existsSync(join(host, ".ralph", "state"))
    ? readdirSync(join(host, ".ralph", "state"))
        .sort()
        .join(",")
    : "",
});

/** Runs a forged result and checks it was refused without any trace on the host. */
function assertRefused(host, run, options) {
  const before = snapshot(host);
  const result = accept(host, run, options);
  assert.equal(result.code, UNTRUSTED, result.output);
  assert.match(result.output, /REFUSED/);
  assert.deepEqual(snapshot(host), before, "a refused run must not change the host");
  assert.notEqual(
    git(host, "for-each-ref", "--format=%(refname)", `refs/ralph/incoming/${basename(run)}/`),
    "",
    "the refused result is kept for inspection",
  );
  return result;
}

describe("ralph-accept: a genuine slice merge", () => {
  it("fast-forwards main after the gate passes again, and records the slice", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    const { slice, merge: tip } = merge(ws);
    const run = finish(host, ws);
    const result = accept(host, run, { base });
    assert.equal(result.code, 0, result.output);
    assert.equal(git(host, "rev-parse", "main"), tip);
    assert.equal(git(host, "rev-parse", "slice/01-demo"), slice);
    assert.equal(readFileSync(join(host, "feature.txt"), "utf8"), "done\n");
    assert.deepEqual(result.verified, [tip], "the merged tree is re-gated by the host");
    assert.equal(git(host, "status", "--porcelain"), "");
    assert.equal(git(host, "for-each-ref", "refs/ralph/incoming/"), "");
    assert.equal(
      readFileSync(join(host, ".ralph", "logs", RUN, "01-demo.agent.log"), "utf8"),
      "agent output\n",
    );
    assert.equal(JSON.parse(readFileSync(join(run, "verdict.json"), "utf8")).outcome, "merged");
  });

  it("accepts a slice that changes dependencies but not the root scripts", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws, "01-demo", {
      change: (dir) =>
        write(dir, "package.json", '{"scripts":{"test":"vitest"},"devDependencies":{"x":"1"}}\n'),
    });
    assert.equal(accept(host, finish(host, ws), { base }).code, 0);
  });

  it("refuses the merge when the host's own gate fails on it", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    const result = assertRefused(host, finish(host, ws), { base, verify: 1 });
    assert.match(result.output, /quality gate failed/);
  });
});

describe("ralph-accept: attack path 1, forged merges and archives", () => {
  const cases = [
    [
      "another ticket marked done under a case variant of issues/",
      (ws) =>
        merge(ws, "01-demo", {
          staged: (dir) => stage(dir, "Issues/02-next.md", NEXT.replace("ready-for-agent", "done")),
        }),
      /only the ticket's own file/,
    ],
    [
      "a merge commit that changes more than its slice",
      (ws) => {
        merge(ws);
        write(ws, "smuggled.txt", "x\n");
        git(ws, "add", "-A");
        git(ws, "commit", "--quiet", "--amend", "--no-edit");
      },
      /changes more than its slice/,
    ],
    [
      "a slice of two commits",
      (ws) =>
        merge(ws, "01-demo", {
          change: (dir) => {
            git(dir, "add", "-A");
            git(dir, "commit", "--quiet", "-m", "extra");
            write(dir, "more.txt", "x\n");
          },
        }),
      /not one commit/,
    ],
    [
      "a commit straight on main",
      (ws) => {
        write(ws, "app.txt", "v2\n");
        git(ws, "commit", "--quiet", "-am", "feat: sneak");
      },
      /neither a slice merge nor/,
    ],
    [
      "a merge and archive of a ticket whose blocker is not done",
      (ws) => merge(ws, "02-next"),
      /blocked by 01/,
    ],
    [
      "a slice that unblocks another ticket",
      (ws) =>
        merge(ws, "01-demo", {
          change: (dir) => write(dir, "issues/02-next.md", NEXT.replace("ready-for-agent", "done")),
        }),
      /only the ticket's own file/,
    ],
    [
      "a slice that rewrites its own ticket",
      (ws) =>
        merge(ws, "01-demo", {
          change: (dir) => {
            const path = join(dir, "issues/done/01-demo.md");
            writeFileSync(path, readFileSync(path, "utf8").replace("works", "anything"));
          },
        }),
      /beyond marking it done/,
    ],
    [
      "a merge without the archive",
      (ws) =>
        merge(ws, "01-demo", {
          change: (dir) => {
            rmSync(join(dir, "issues/done/01-demo.md"));
            write(dir, "issues/01-demo.md", DEMO);
          },
        }),
      /does not archive its ticket/,
    ],
    [
      "a slice commit that is not Ralph's",
      (ws) => merge(ws, "01-demo", { subject: "feat: anything" }),
      /is not "feat\(slice-01\)/,
    ],
  ];
  for (const [name, forge, reason] of cases) {
    it(`refuses ${name}`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      forge(ws);
      const result = assertRefused(host, finish(host, ws), { base, ticket: "" });
      assert.match(result.output, reason);
      assert.deepEqual(result.verified, [], "nothing forged reaches the gate, let alone main");
    });
  }

  it("refuses a genuine merge of a ticket the run was not given", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    assertRefused(host, finish(host, ws), { base, ticket: "02" });
  });

  it("refuses a slice branch that is not the merged slice", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    git(ws, "branch", "--quiet", "--force", "slice/01-demo", base);
    assertRefused(host, finish(host, ws), { base });
  });
});

describe("ralph-accept: attack path 2, Git configuration, hooks and links", () => {
  for (const [name, path, text] of [
    ["Git attributes", ".gitattributes", "* filter=lfs\n"],
    ["a nested Git attributes file", "src/.gitattributes", "*.txt diff=evil\n"],
    ["a submodule declaration", ".gitmodules", '[submodule "x"]\n\tpath = x\n\turl = ../x\n'],
    ["an upper-case Git attributes file", ".GITATTRIBUTES", "* filter=lfs\n"],
    ["a Git attributes file with a trailing dot", "src/.gitattributes.", "* diff=evil\n"],
  ]) {
    it(`refuses a slice that adds ${name}`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      merge(ws, "01-demo", { staged: (dir) => stage(dir, path, text) });
      assert.match(assertRefused(host, finish(host, ws), { base }).output, /Git attributes/);
    });
  }

  it("refuses a slice that adds a symlink", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws, "01-demo", {
      // A symlink as Git stores it, staged directly: whatever the platform can create on disk.
      staged: (dir) => {
        const blob = git(dir, "hash-object", "-w", "app.txt");
        git(dir, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
      },
    });
    assert.match(assertRefused(host, finish(host, ws), { base }).output, /link: symlink/);
  });

  it("runs none of the container's hooks or configuration when it accepts a run", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    // Everything a container could plant in its own repository to run code on whoever uses it.
    // Each writes `pwned` into the checkout it runs in, so a run on the host leaves it there.
    const hook = "#!/bin/sh\necho pwned > pwned\n";
    for (const name of ["post-merge", "post-checkout", "reference-transaction", "pre-push"]) {
      writeFileSync(join(ws, ".git", "hooks", name), hook, { mode: 0o755 });
    }
    git(ws, "config", "core.fsmonitor", "echo pwned > pwned");
    git(ws, "config", "core.hooksPath", ".git/hooks");
    git(ws, "config", "uploadpack.packObjectsHook", "echo pwned > pwned");
    const configBefore = readFileSync(join(host, ".git", "config"), "utf8");
    const run = finish(host, ws);
    const marker = join(host, "pwned");
    const result = accept(host, run, { base });
    assert.equal(result.code, 0, result.output);
    assert.equal(existsSync(marker), false, "no container hook or config ran on the host");
    assert.equal(readFileSync(join(host, ".git", "config"), "utf8"), configBefore);
    assert.deepEqual(
      readdirSync(join(host, ".git", "hooks")).filter((name) => !name.endsWith(".sample")),
      [],
    );
  });

  it("copies logs as plain files and drops links out of the run directory", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    const run = finish(host, ws);
    // A directory link (a junction on Windows) pointing at the host repository's Git metadata.
    symlinkSync(join(host, ".git"), join(run, "out", "logs", RUN, "escape"), "junction");
    write(host, `.ralph/logs/${RUN}/existing.log`, "host copy\n");
    write(join(run, "out"), `logs/${RUN}/existing.log`, "container copy\n");
    assert.equal(accept(host, run, { base }).code, 0);
    assert.equal(existsSync(join(host, ".ralph", "logs", RUN, "escape")), false);
    assert.equal(
      readFileSync(join(host, ".ralph", "logs", RUN, "existing.log"), "utf8"),
      "host copy\n",
    );
  });
});

describe("ralph-accept: attack path 3, harness, CI and gate definitions", () => {
  for (const [name, change] of [
    [
      "the CI check the batch runs on the host",
      (dir) => write(dir, "scripts/ralph-ci.sh", "exit 0 # forged\n"),
    ],
    ["the GitHub CI workflow", (dir) => write(dir, ".github/workflows/ci.yml", "name: nothing\n")],
    ["the importer itself", (dir) => write(dir, "scripts/ralph-accept.mjs", "process.exit(0)\n")],
    ["the loop", (dir) => write(dir, "ralph-loop.sh", "exit 0\n")],
    ["the review skill", (dir) => write(dir, "skills/code-review/SKILL.md", "approve all\n")],
    ["the root gate scripts", (dir) => write(dir, "package.json", '{"scripts":{"test":"true"}}\n')],
  ]) {
    it(`refuses a slice that changes ${name}`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      merge(ws, "01-demo", { change });
      const result = assertRefused(host, finish(host, ws), { base });
      assert.match(result.output, /protected|define the gate/);
      assert.equal(readFileSync(join(host, "scripts/ralph-ci.sh"), "utf8"), "exit 0\n");
    });
  }

  // Spellings a case-insensitive host (Windows, macOS) resolves to a protected file.
  for (const [name, path, reason] of [
    ["a case variant", "Scripts/ralph-ci.sh", /protected/],
    ["a trailing dot", "scripts./ralph-ci.sh", /protected/],
    ["a trailing space", "scripts /ralph-ci.sh", /protected/],
    ["an upper-case workflow", ".GITHUB/workflows/ci.yml", /protected/],
    ["an 8.3 short name", "SCRIPT~1/ralph-ci.sh", /not a portable path/],
    ["a stream name", "scripts/ralph-ci.sh:evil", /not a portable path/],
  ]) {
    it(`refuses ${name} of the host's CI check (${path})`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      merge(ws, "01-demo", { staged: (dir) => stage(dir, path, "exit 0 # forged\n") });
      assert.match(assertRefused(host, finish(host, ws), { base }).output, reason);
      assert.equal(readFileSync(join(host, "scripts/ralph-ci.sh"), "utf8"), "exit 0\n");
    });
  }

  it("refuses two spellings of one file, which a case-insensitive checkout would merge", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws, "01-demo", { staged: (dir) => stage(dir, "APP.txt", "replaced\n") });
    const result = assertRefused(host, finish(host, ws), { base });
    assert.match(result.output, /same file on a case-insensitive host/);
    assert.equal(readFileSync(join(host, "app.txt"), "utf8"), "v1\n");
  });

  it("masks control characters from the container's path names in its output", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws, "01-demo", {
      staged: (dir) => stage(dir, "x\u001b]0;owned\u0007\u009b2J.txt", "x\n"),
    });
    const result = assertRefused(host, finish(host, ws), { base });
    assert.match(result.output, /not a portable path/);
    for (const char of ["\u001b", "\u0007", "\u009b"]) {
      assert.equal(
        result.output.includes(char),
        false,
        "no raw control character reaches the terminal",
      );
    }
  });

  for (const [name, path, text] of [
    ["a nested Biome configuration", "packages/demo/biome.json", '{"linter":{"enabled":false}}\n'],
    ["a nested npm configuration", "packages/demo/.npmrc", "ignore-scripts=false\n"],
    ["the workspace definition", "pnpm-workspace.yaml", "packages: []\n"],
    ["the infrastructure definition", "docker-compose.yml", "services: {}\n"],
    ["the infrastructure directory", "infra/nats.conf", "jetstream: off\n"],
    ["the Node version", ".nvmrc", "18\n"],
  ]) {
    it(`refuses a slice that changes ${name}`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      merge(ws, "01-demo", { change: (dir) => write(dir, path, text) });
      assert.match(assertRefused(host, finish(host, ws), { base }).output, /protected/);
    });
  }

  for (const [name, change] of [
    [
      "redefines a package's test script",
      (dir) => write(dir, "packages/demo/package.json", '{"scripts":{"test":"true","dev":"x"}}\n'),
    ],
    [
      "removes a package's test script",
      (dir) => write(dir, "packages/demo/package.json", '{"scripts":{"dev":"x"}}\n'),
    ],
    ["deletes a package", (dir) => rmSync(join(dir, "packages/demo/package.json"))],
  ]) {
    it(`refuses a slice that ${name}`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      merge(ws, "01-demo", { change });
      assert.match(
        assertRefused(host, finish(host, ws), { base }).output,
        /define the gate|removes its tests/,
      );
    });
  }

  it("accepts a slice that changes a package's dependencies and other scripts, or adds one", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws, "01-demo", {
      change: (dir) => {
        write(
          dir,
          "packages/demo/package.json",
          '{"scripts":{"test":"vitest run","dev":"y"},"dependencies":{"zod":"4.0.0"}}\n',
        );
        write(dir, "packages/new/package.json", '{"scripts":{"test":"vitest run"}}\n');
      },
    });
    const result = accept(host, finish(host, ws), { base });
    assert.equal(result.code, 0, result.output);
    assert.match(readFileSync(join(host, "packages/demo/package.json"), "utf8"), /zod/);
  });
});

describe("ralph-accept: attack path 4, pause and resume checkpoints", () => {
  it("adopts a genuine pause in canonical form and parks the work on the host", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    const parked = pause(ws);
    const run = finish(host, ws, {
      state: { "01-demo.pause": parked.state, "01-demo.feedback.log": "gate output\n" },
    });
    const result = accept(host, run, { base, exit: PAUSED });
    assert.equal(result.code, PAUSED, result.output);
    assert.equal(git(host, "rev-parse", "main"), base);
    assert.equal(git(host, "rev-parse", "ralph/paused/01-demo"), parked.paused);
    assert.equal(readFileSync(join(host, ".ralph/state/01-demo.pause"), "utf8"), parked.state);
    assert.equal(
      readFileSync(join(host, ".ralph/state/01-demo.feedback.log"), "utf8"),
      "gate output\n",
    );
  });

  const forgeries = [
    ["a pause from a run that did not pause", (p) => p.state, { exit: 0 }],
    [
      "a parked ref that is not on its checkpoint",
      (p) => p.state.replace(`gated=${p.gated}`, `gated=${p.base}`),
      {},
    ],
    [
      "a pause on another base",
      (p) => p.state.replace(`base=${p.base}`, `base=${"a".repeat(40)}`),
      {},
    ],
    ["a pause with an extra line", (p) => `${p.state}phase=verify\n`, {}],
    ["a pause with an unknown key", (p) => `${p.state}skip=review\n`, {}],
    [
      "a pause for another ticket's ref",
      (p) => p.state.replace("ref=ralph/paused/01-demo", "ref=ralph/paused/02-next"),
      {},
    ],
    ["a pause beyond the attempt limit", (p) => p.state.replace("attempt=2", "attempt=99"), {}],
  ];
  for (const [name, forge, options] of forgeries) {
    it(`refuses ${name}`, () => {
      const host = hostRepo();
      const base = git(host, "rev-parse", "main");
      const ws = container(host);
      const parked = pause(ws);
      const run = finish(host, ws, { state: { "01-demo.pause": forge(parked) } });
      assertRefused(host, run, { base, exit: PAUSED, ...options });
    });
  }

  it("refuses a state file Ralph never writes", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    const run = finish(host, ws, { state: { "01-demo.sh": "rm -rf /\n" } });
    assertRefused(host, run, { base });
  });

  it("refuses parked work that changes the harness", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    const parked = pause(ws, "01-demo", {
      work: (dir) => write(dir, "scripts/ralph-ci.sh", "x\n"),
    });
    const run = finish(host, ws, { state: { "01-demo.pause": parked.state } });
    assert.match(assertRefused(host, run, { base, exit: PAUSED }).output, /protected/);
  });

  it("clears the host's pause once the resumed ticket merges, and keeps unrelated ones", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    // A first run parks ticket 01.
    let ws = container(host);
    const parked = pause(ws);
    let run = finish(host, ws, { state: { "01-demo.pause": parked.state } });
    assert.equal(accept(host, run, { base, exit: PAUSED }).code, PAUSED);
    write(host, ".ralph/state/02-next.pause", "held by the host\n");
    // The resumed run merges it; the container hands the unrelated state back unchanged.
    ws = container(host);
    const { merge: tip } = merge(ws);
    run = finish(host, ws, { name: "run2", state: { "02-next.pause": "held by the host\n" } });
    const result = accept(host, run, { base });
    assert.equal(result.code, 0, result.output);
    assert.equal(git(host, "rev-parse", "main"), tip);
    assert.equal(existsSync(join(host, ".ralph/state/01-demo.pause")), false);
    assert.equal(git(host, "for-each-ref", "refs/heads/ralph/paused/"), "");
    assert.equal(
      readFileSync(join(host, ".ralph/state/02-next.pause"), "utf8"),
      "held by the host\n",
    );
  });
});

describe("ralph-accept: rejected and interrupted runs", () => {
  it("adopts a genuine rejection: blocked status on main, work on its quarantine branch", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    reject(ws);
    const result = accept(host, finish(host, ws), { base, exit: 1 });
    assert.equal(result.code, 1, result.output);
    assert.match(readFileSync(join(host, "issues/01-demo.md"), "utf8"), /\*\*Status:\*\* blocked/);
    assert.equal(git(host, "cat-file", "-p", `rejected/01-demo-${RUN}:half-done.txt`), "wip");
    assert.equal(
      existsSync(join(host, "half-done.txt")),
      false,
      "rejected work never reaches main",
    );
    assert.deepEqual(result.verified, []);
  });

  it("refuses a blocked-status commit that changes more than the status line", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    reject(ws, "01-demo", (text) =>
      text.replace(/^\*\*Status:\*\* .*$/m, "**Status:** blocked").replace("works", "nothing"),
    );
    assertRefused(host, finish(host, ws), { base, exit: 1 });
  });

  it("changes nothing when a run left no result", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const run = join(host, ".ralph", "sandbox", "run1");
    mkdirSync(join(run, "out"), { recursive: true });
    const before = snapshot(host);
    assert.equal(accept(host, run, { base, exit: 137 }).code, 1);
    assert.deepEqual(snapshot(host), before);
  });

  it("does not treat a claimed pause without parked work as a pause", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    const result = accept(host, finish(host, ws), { base, exit: PAUSED });
    assert.equal(result.code, 1, result.output);
    assert.equal(existsSync(join(host, ".ralph/state")), false);
  });

  it("applies nothing when the host checkout changed during the run", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    const run = finish(host, ws);
    write(host, "app.txt", "edited meanwhile\n");
    const result = accept(host, run, { base });
    assert.equal(result.code, 1, result.output);
    assert.equal(git(host, "rev-parse", "main"), base);
    assert.equal(readFileSync(join(host, "app.txt"), "utf8"), "edited meanwhile\n");
  });
});

describe("ralph-accept: what the container leaves in out/", () => {
  it("refuses a result bundle that is not a plain file", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const run = join(host, ".ralph", "sandbox", "run1");
    mkdirSync(join(run, "out", "result.bundle"), { recursive: true });
    const before = snapshot(host);
    const result = accept(host, run, { base });
    assert.equal(result.code, UNTRUSTED, result.output);
    assert.match(result.output, /result\.bundle is not a plain file/);
    assert.deepEqual(snapshot(host), before);
  });

  it("refuses a state directory that links elsewhere", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    const run = finish(host, ws);
    const elsewhere = mkdtempSync(join(tmpdir(), "ralph-elsewhere-"));
    rmSync(join(run, "out", "state"), { recursive: true });
    symlinkSync(elsewhere, join(run, "out", "state"), "junction");
    assert.match(assertRefused(host, run, { base }).output, /state is not a plain directory/);
  });

  it("imports no logs through a logs directory that links elsewhere, and still accepts", () => {
    const host = hostRepo();
    const base = git(host, "rev-parse", "main");
    const ws = container(host);
    merge(ws);
    const run = finish(host, ws, { logs: false });
    const elsewhere = mkdtempSync(join(tmpdir(), "ralph-elsewhere-"));
    write(elsewhere, `${RUN}/secret.log`, "not the run's\n");
    symlinkSync(elsewhere, join(run, "out", "logs"), "junction");
    const result = accept(host, run, { base });
    assert.equal(result.code, 0, result.output);
    assert.equal(existsSync(join(host, ".ralph", "logs", RUN, "secret.log")), false);
  });
});
