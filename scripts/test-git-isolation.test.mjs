// Tests for scripts/test-git-isolation.sh, which every bash test suite sources first (TD-091).
// Git's repository-local variables outrank discovery: a hook running in a linked worktree exports
// an absolute GIT_DIR and GIT_INDEX_FILE, and a suite's fixture `git -C dir init/commit` would
// then write to the real repository. The scenario is reproduced against a decoy repository.

import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const helper = join(scripts, "test-git-isolation.sh").replaceAll("\\", "/");
const portable = (path) => path.replaceAll("\\", "/");

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repository standing in for the real one, with one commit and one staged file. */
function decoy() {
  const dir = mkdtempSync(join(tmpdir(), "decoy-"));
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "real",
  );
  return {
    dir,
    head: () => git(dir, "rev-parse", "HEAD"),
    index: () => statSync(join(dir, ".git", "index"), { throwIfNoEntry: false })?.mtimeMs ?? 0,
  };
}

/** Runs a suite-like bash script with the decoy's variables inherited, as a hook would pass them. */
function runFixture(real, { isolate }) {
  const work = mkdtempSync(join(tmpdir(), "suite-"));
  const script = [
    "set -Eeuo pipefail",
    isolate ? `source "${helper}"` : ":",
    "git init --quiet --initial-branch=main fixture",
    "echo demo >fixture/demo.txt",
    "git -C fixture add demo.txt",
    "git -C fixture -c user.name=t -c user.email=t@t commit --quiet -m fixture",
    "git -C fixture rev-list --count HEAD",
  ].join("\n");
  const gitDir = portable(join(real.dir, ".git"));
  return spawnSync("bash", ["-c", script], {
    cwd: work,
    encoding: "utf8",
    // Exactly what Git 2.45 exports to a hook in a linked worktree (observed 2026-11-13).
    env: { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: `${gitDir}/index` },
  });
}

describe("test-git-isolation.sh", () => {
  it("without it, a fixture commit lands in the repository the caller's GIT_DIR names", () => {
    // Negative control: proves the scenario the helper guards against is real on this Git.
    const real = decoy();
    const before = real.head();
    runFixture(real, { isolate: false });
    assert.notEqual(real.head(), before);
  });

  it("keeps a fixture's commit in the fixture when the caller exports GIT_DIR and GIT_INDEX_FILE", () => {
    const real = decoy();
    const head = real.head();
    const index = real.index();
    const result = runFixture(real, { isolate: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "1", "the fixture holds exactly its own commit");
    assert.equal(real.head(), head, "the real repository's HEAD moved");
    assert.equal(real.index(), index, "the real repository's index was written");
  });

  it("clears every repository-local variable the running Git names", () => {
    // Every name inherited at once, including any that makes Git itself refuse: Git 2.39 (the
    // sandbox image's) lists GIT_INTERNAL_SUPER_PREFIX, and `rev-parse` exits 128 when it is set.
    const names = git(scripts, "rev-parse", "--local-env-vars").split("\n");
    const env = { ...process.env, ...Object.fromEntries(names.map((name) => [name, "inherited"])) };
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail; source "${helper}"; env | grep -E '^GIT_[A-Z_]+=inherited$' || true`,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("is sourced by every bash test suite before anything else runs", () => {
    // Running each suite with an inherited GIT_DIR would take hours and Docker, so this checks the
    // wiring: the line right after `set -Eeuo pipefail` sources the helper, in every suite.
    const suites = readdirSync(scripts).filter((name) => name.endsWith(".test.sh"));
    assert.ok(suites.length >= 5, `found only ${suites.join(", ")}`);
    for (const suite of suites) {
      const lines = readFileSync(join(scripts, suite), "utf8").split("\n");
      const set = lines.indexOf("set -Eeuo pipefail");
      assert.ok(set >= 0, `${suite}: no "set -Eeuo pipefail"`);
      assert.match(
        lines[set + 1] ?? "",
        /^source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/test-git-isolation\.sh"$/,
        `${suite} does not source test-git-isolation.sh first`,
      );
    }
  });
});
