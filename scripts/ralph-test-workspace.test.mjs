// Scenario tests for scripts/ralph-test-workspace.mjs. Each scenario runs a real child process
// that imports the helper, under its own workspace root, and then inspects what is left on disk.
// The public interface is the import and its two environment variables; the recovery functions
// are exported for the scenarios no sequence of real processes can stage.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recoverDeadSessions, recoverSessions } from "./ralph-test-workspace.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repo = dirname(scriptsDir);
const helperUrl = pathToFileURL(join(scriptsDir, "ralph-test-workspace.mjs")).href;
const HEADER = `
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { workspace } from ${JSON.stringify(helperUrl)};
const scratch = (name = "fixture-") => mkdtempSync(join(tmpdir(), name));
`;

function childEnv(root, extra = {}) {
  // A nested `node --test` that inherits this variable reports to its parent's protocol.
  const { NODE_TEST_CONTEXT: _context, RALPH_TEST_KEEP_FAILED: _keep, ...env } = process.env;
  return { ...env, RALPH_TEST_TMP_ROOT: root, ...extra };
}

function lab() {
  const dir = mkdtempSync(join(tmpdir(), "lab-"));
  return { dir, root: join(dir, "root") };
}

function writeChild(dir, body, name = "child.test.mjs") {
  const file = join(dir, name);
  writeFileSync(file, `${HEADER}\n${body}\n`);
  return file;
}

function runTests(dir, root, body, extra = {}) {
  const file = writeChild(dir, body);
  return spawnSync(process.execPath, ["--test", file], {
    encoding: "utf8",
    env: childEnv(root, extra),
  });
}

function runScript(dir, root, body, extra = {}) {
  const file = writeChild(dir, body, "child.mjs");
  return spawnSync(process.execPath, [file], { encoding: "utf8", env: childEnv(root, extra) });
}

/** Starts a script that stays alive, and resolves once it has printed its session's directory. */
function startLive(dir, root) {
  const file = writeChild(
    dir,
    `console.log(workspace.session);\nsetInterval(() => {}, 1000);`,
    `live-${readdirSync(dir).length}.mjs`,
  );
  const child = spawn(process.execPath, [file], {
    env: childEnv(root),
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (data) => resolve({ child, session: data.toString().trim() }));
  });
}

function stop(child, signal = "SIGKILL") {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill(signal);
  });
}

const sessions = (root) => {
  const dir = join(root, "sessions");
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** A session a process left behind: a directory with fixtures, and its owner record. */
function plantSession(root, id, owner) {
  const session = join(root, "sessions", `session-${id}`);
  mkdirSync(join(session, "tmp", "ralph-accept-LEFT00"), { recursive: true });
  writeFileSync(join(session, "tmp", "ralph-accept-LEFT00", "file.txt"), "left behind");
  writeFileSync(join(root, "sessions", `session-${id}.owner.json`), JSON.stringify(owner));
  return session;
}

/** Creates the root's layout through a real run of the helper. */
function initialiseRoot(root) {
  const result = runScript(
    mkdtempSync(join(tmpdir(), "id-")),
    root,
    "console.log(workspace.session);",
  );
  assert.equal(result.status, 0, result.stderr);
  return result;
}

// node:test prints its summary after a plain script that merely imported it.
const firstLine = (result) => result.stdout.split(/\r?\n/)[0].trim();

const noop = "it('passes', () => { scratch(); });";

const DEAD_OWNER = { pid: 999999, name: "node", startTime: "1", hostname: hostname() };

describe("ralph-test-workspace: normal completion", () => {
  it("creates fixtures under the configured root and leaves nothing after a pass", () => {
    const { dir, root } = lab();
    const result = runTests(
      dir,
      root,
      `it("is inside the workspace", () => {
         const made = scratch();
         writeFileSync(join(made, "a.txt"), "x");
         if (!made.replaceAll("\\\\", "/").startsWith(workspace.root.replaceAll("\\\\", "/"))) {
           throw new Error("outside the workspace: " + made);
         }
       });`,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(sessions(root), []);
  });

  it("removes each test's directories before the next test, and keeps file-level fixtures", () => {
    const { dir, root } = lab();
    const result = runTests(
      dir,
      root,
      `const shared = scratch("shared-");
       let first;
       it("first", () => { first = scratch(); });
       it("second", () => {
         if (existsSync(first)) throw new Error("the first test's directory survived");
         if (!existsSync(shared)) throw new Error("a file-level fixture was removed");
       });`,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(sessions(root), []);
  });

  it("defaults to the project-local root when no root is configured", () => {
    const { dir } = lab();
    const file = writeChild(dir, "console.log(workspace.root);", "child.mjs");
    const { RALPH_TEST_TMP_ROOT: _root, ...env } = childEnv("unused");
    const result = spawnSync(process.execPath, [file], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(relative(join(repo, ".ralph", "tmp", "harness"), firstLine(result)), "");
  });

  it("gives child processes the same temporary directory", () => {
    const { dir, root } = lab();
    const result = runScript(
      dir,
      root,
      `const r = spawnSync(process.execPath, ["-p", "require('node:os').tmpdir()"], { encoding: "utf8" });
       console.log(r.stdout.trim() === tmpdir() && tmpdir().includes("session-") ? "same" : r.stdout);`,
    );
    assert.equal(firstLine(result), "same", result.stderr);
  });
});

describe("ralph-test-workspace: failures", () => {
  const failing = `it("fails", () => { scratch("failed-"); throw new Error("boom"); });
                   it("passes", () => { scratch("passed-"); });`;

  it("removes a failed test's workspace by default", () => {
    const { dir, root } = lab();
    const result = runTests(dir, root, failing);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(sessions(root), []);
    assert.equal(existsSync(join(root, "kept-failed")), false);
  });

  it("keeps only the failed test's workspace when RALPH_TEST_KEEP_FAILED=1", () => {
    const { dir, root } = lab();
    const result = runTests(dir, root, failing, { RALPH_TEST_KEEP_FAILED: "1" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(sessions(root), []);
    const [session] = readdirSync(join(root, "kept-failed"));
    const kept = readdirSync(join(root, "kept-failed", session));
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^failed-/);
  });
});

describe("ralph-test-workspace: forced termination and recovery", () => {
  for (const signal of ["SIGKILL", "SIGTERM"]) {
    it(`leaves no session behind once the next run follows a ${signal}`, async () => {
      const { dir, root } = lab();
      const { child, session } = await startLive(dir, root);
      writeFileSync(join(session, "tmp", "marker.txt"), "x");
      await stop(child, signal);
      const result = runScript(dir, root, "console.log(workspace.session);");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(session), false, "the dead process's session was recovered");
      assert.deepEqual(sessions(root), []);
    });
  }

  it("recovers a session whose process ID was reused by a process that started later", async () => {
    const { dir, root } = lab();
    const live = await startLive(dir, root);
    const ownerFile = `${live.session}.owner.json`;
    const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
    const planted = plantSession(root, "reused", { ...owner, startTime: "1" });
    runScript(dir, root, "console.log(workspace.session);");
    assert.equal(existsSync(planted), false, "same PID, different start time is another process");
    assert.ok(existsSync(live.session), "the real owner's session is untouched");
    await stop(live.child);
  });

  it("recovers a session whose process ID now names a different program", async () => {
    const { dir, root } = lab();
    const live = await startLive(dir, root);
    const owner = JSON.parse(readFileSync(`${live.session}.owner.json`, "utf8"));
    const planted = plantSession(root, "renamed", { ...owner, name: "not-node" });
    runScript(dir, root, "console.log(workspace.session);");
    assert.equal(existsSync(planted), false);
    await stop(live.child);
  });
});

describe("ralph-test-workspace: live and unproven sessions", () => {
  it("never touches a session whose owner is still running", async () => {
    const { dir, root } = lab();
    const { child, session } = await startLive(dir, root);
    writeFileSync(join(session, "tmp", "in-use.txt"), "x");
    const result = runScript(dir, root, "console.log(workspace.session);");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(session, "tmp", "in-use.txt")));
    await stop(child);
  });

  it("leaves a session alone when its owner cannot be proven dead", () => {
    const { dir, root } = lab();
    initialiseRoot(root);
    const dead = plantSession(root, "dead", DEAD_OWNER);
    const foreign = plantSession(root, "foreign", {
      pid: 1,
      name: "node",
      startTime: "1",
      hostname: `${hostname()}-another-machine`,
    });
    const noStart = plantSession(root, "unknown", {
      pid: 999999,
      name: "node",
      startTime: null,
      hostname: hostname(),
    });
    const corrupt = join(root, "sessions", "session-corrupt");
    mkdirSync(join(corrupt, "tmp"), { recursive: true });
    writeFileSync(`${corrupt}.owner.json`, "{not json");
    const orphan = join(root, "sessions", "session-noowner");
    mkdirSync(join(orphan, "tmp"), { recursive: true });
    const result = runScript(dir, root, "console.log(workspace.session);");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(dead), false, "recovery ran, so what stays below was judged");
    for (const path of [foreign, noStart, corrupt, orphan]) {
      assert.ok(existsSync(path), `${path} has no proof of death and must stay`);
    }
  });

  // Each of these needs a process table no real process can be made to produce on demand.
  const judged = (id) => [{ name: `session-${id}`, owner: DEAD_OWNER }];
  const sessionsOf = (root) => join(root, "sessions");

  it("does not judge an owner that appears while the processes are being listed", () => {
    const { root } = lab();
    mkdirSync(sessionsOf(root), { recursive: true });
    const listed = plantSession(root, "listed", DEAD_OWNER);
    let arrived = "";
    recoverSessions(sessionsOf(root), () => {
      arrived = plantSession(root, "arrived", DEAD_OWNER);
      return new Map();
    });
    assert.equal(existsSync(listed), false, "the listed owner is absent from the table: dead");
    assert.ok(existsSync(arrived), "a session started meanwhile must not be taken for dead");
    assert.ok(existsSync(`${arrived}.owner.json`), "nor lose its owner record");
  });

  it("removes nothing when the system could not be asked about its processes", () => {
    const { root } = lab();
    const session = plantSession(root, "unasked", DEAD_OWNER);
    recoverDeadSessions(sessionsOf(root), judged("unasked"), null);
    assert.ok(existsSync(session));
  });

  it("leaves a session whose running process's start time could not be read", () => {
    const { root } = lab();
    const session = plantSession(root, "unreadable", DEAD_OWNER);
    const table = new Map([[DEAD_OWNER.pid, { name: "other-program", startTime: "" }]]);
    recoverDeadSessions(sessionsOf(root), judged("unreadable"), table);
    assert.ok(existsSync(session));
  });
});

describe("ralph-test-workspace: repeated runs", () => {
  it("does not accumulate anything over repeated runs, whether they pass or fail", () => {
    const { dir, root } = lab();
    for (const body of [
      noop,
      noop,
      "it('fails', () => { scratch(); throw new Error('x'); });",
      noop,
    ]) {
      runTests(dir, root, body);
      assert.deepEqual(sessions(root), []);
    }
    assert.deepEqual(readdirSync(root).sort(), ["sessions"]);
  });
});

describe("ralph-test-workspace: evidence retention", () => {
  for (const keepFailed of ["0", "1"]) {
    it(`leaves failure-injection artifacts alone through recovery and a failing run (RALPH_TEST_KEEP_FAILED=${keepFailed})`, () => {
      const { dir, root } = lab();
      const beside = join(dir, "failure-injection-2", "evidence");
      mkdirSync(beside, { recursive: true });
      writeFileSync(join(beside, "run.log"), "evidence");
      initialiseRoot(root);
      const inside = join(root, "failure-injection-1");
      mkdirSync(inside);
      writeFileSync(join(inside, "run.log"), "evidence");
      const dead = plantSession(root, "dead", DEAD_OWNER);
      const result = runTests(
        dir,
        root,
        "it('fails', () => { scratch(); throw new Error('x'); });",
        {
          RALPH_TEST_KEEP_FAILED: keepFailed,
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(existsSync(dead), false, "recovery ran, so the evidence was within its reach");
      assert.equal(readFileSync(join(beside, "run.log"), "utf8"), "evidence");
      assert.equal(readFileSync(join(inside, "run.log"), "utf8"), "evidence");
    });
  }
});

describe("ralph-test-workspace: junction safety", () => {
  function realTarget(dir) {
    const target = join(dir, "real-target");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "must survive");
    return target;
  }
  const survived = (target) =>
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "must survive");

  it("removes a fixture's links without following them", () => {
    const { dir, root } = lab();
    const target = realTarget(dir);
    const result = runTests(
      dir,
      root,
      `it("links out", () => {
         const made = scratch();
         mkdirSync(join(made, "node_modules"));
         symlinkSync(${JSON.stringify(target)}, join(made, "node_modules", "yaml"), "junction");
         symlinkSync(${JSON.stringify(target)}, join(tmpdir(), "top-level-link"), "junction");
       });`,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    survived(target);
    assert.deepEqual(sessions(root), []);
  });

  it("recovers a killed session holding a link without following it", async () => {
    const { dir, root } = lab();
    const target = realTarget(dir);
    const { child, session } = await startLive(dir, root);
    symlinkSync(target, join(session, "tmp", "linked"), "junction");
    await stop(child);
    const result = runScript(dir, root, "console.log(workspace.session);");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(session), false);
    survived(target);
  });

  it("unlinks a session entry that is itself a link, leaving its target", () => {
    const { dir, root } = lab();
    initialiseRoot(root);
    const target = realTarget(dir);
    const entry = join(root, "sessions", "session-linked");
    symlinkSync(target, entry, "junction");
    writeFileSync(`${entry}.owner.json`, JSON.stringify(DEAD_OWNER));
    runScript(dir, root, "console.log(workspace.session);");
    assert.throws(() => lstatSync(entry), /ENOENT/);
    survived(target);
  });
});

describe("ralph-test-workspace: the boundary of the real repository", () => {
  const refused = (root, pattern) => {
    const { dir } = lab();
    const result = runScript(dir, root, "console.log('STARTED ' + tmpdir());");
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /STARTED/);
    assert.match(result.stderr, pattern);
  };

  it("fails explicitly, without a fallback, when the configured root is unusable", () => {
    const { dir } = lab();
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    refused("relative/path", /RALPH_TEST_TMP_ROOT.*absolute/);
    refused("", /RALPH_TEST_TMP_ROOT.*absolute/);
    refused(join(file, "below"), /RALPH_TEST_TMP_ROOT.*unavailable/);
  });

  it("refuses a root that is, contains or sits among the repository's protected paths", () => {
    refused(repo, /repository/);
    refused(dirname(repo), /repository/);
    // Windows paths compare without case, so this spelling is the repository too.
    if (process.platform === "win32") {
      refused(repo.toLowerCase(), /repository/);
    }
    refused(join(repo, ".ralph"), /\.ralph[/\\]tmp/);
    refused(join(repo, ".ralph", "tmp"), /\.ralph[/\\]tmp/);
    refused(join(repo, "scripts", "harness"), /\.ralph[/\\]tmp/);
    refused(join(repo, ".ralph", "tmp", "failure-injection"), /failure-injection/);
    refused(join(repo, ".ralph", "tmp", "Failure-Injection-2", "x"), /failure-injection/);
  });

  it("refuses a root that reaches the repository through a link", () => {
    const { dir } = lab();
    const link = join(dir, "looks-outside");
    symlinkSync(repo, link, "junction");
    refused(link, /repository/);
    assert.equal(existsSync(join(repo, "sessions")), false, "refused before creating anything");
  });

  it("stops Git discovery from a fixture directory reaching the real repository", () => {
    const { dir, root } = lab();
    const result = runScript(
      dir,
      root,
      `const made = scratch();
       const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: made, encoding: "utf8" });
       console.log(r.status, r.stdout.trim());`,
    );
    assert.equal(firstLine(result), "128", result.stderr);
  });

  it("keeps inherited Git repository variables from redirecting a fixture's Git", () => {
    const { dir, root } = lab();
    const elsewhere = join(dir, "elsewhere");
    assert.equal(spawnSync("git", ["init", "--quiet", elsewhere]).status, 0);
    const result = runScript(
      dir,
      root,
      `const made = scratch();
       spawnSync("git", ["init", "--quiet"], { cwd: made });
       const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: made, encoding: "utf8" });
       console.log(r.stdout.trim());`,
      {
        GIT_DIR: join(elsewhere, ".git"),
        GIT_WORK_TREE: elsewhere,
        GIT_INDEX_FILE: join(elsewhere, ".git", "index"),
      },
    );
    assert.equal(firstLine(result), ".git", result.stderr);
  });

  it("is imported by every test file that uses the system's temporary directory", () => {
    const leaking = readdirSync(scriptsDir)
      .filter((name) => name.endsWith(".test.mjs"))
      .filter((name) => {
        const text = readFileSync(join(scriptsDir, name), "utf8");
        return /\btmpdir\(\)/.test(text) && !text.includes('"./ralph-test-workspace.mjs"');
      });
    assert.deepEqual(leaking, []);
  });
});
