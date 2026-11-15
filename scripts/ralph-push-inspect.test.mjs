import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  contentRules,
  inspectCommits,
  parsePatch,
  pathRule,
  printable,
} from "./ralph-push-inspect.mjs";

const script = fileURLToPath(new URL("./ralph-push-inspect.mjs", import.meta.url));
// Built at run time so this file itself holds no credential-shaped literal.
const FAKE_AWS = ["AKIA", "Z".repeat(16)].join("");
const FAKE_GITHUB = ["ghp", "_", "a1".repeat(18)].join("");

describe("what the push inspection refuses", () => {
  it("refuses workflow, env and key files, and allows the env example", () => {
    assert.equal(pathRule(".github/workflows/ci.yml"), ".github/ file");
    assert.equal(pathRule("apps/web/.github/x.yml"), ".github/ file");
    assert.equal(pathRule(".env"), "env file");
    assert.equal(pathRule("apps/web/.env.local"), "env file");
    assert.equal(pathRule("deploy/server.pem"), "key file");
    assert.equal(pathRule("home/id_ed25519"), "key file");
    assert.equal(pathRule("deploy/prod.env"), "env file");
    assert.equal(pathRule(".npmrc"), "credential file");
    assert.equal(pathRule("home/.git-credentials"), "credential file");
    assert.equal(pathRule("infra/prod.tfvars"), "key file");
    assert.equal(pathRule(".env.example"), null);
    assert.equal(pathRule("docs/github.md"), null);
    assert.equal(pathRule("src/environment.ts"), null);
  });

  it("recognises credential patterns and leaves ordinary code alone", () => {
    const flagged = {
      [`const key = "${FAKE_AWS}";`]: "AWS access key",
      [`token: ${FAKE_GITHUB}`]: "GitHub token",
      ["-----BEGIN RSA PRIVATE KEY-----"]: "private key",
      ["DATABASE_URL=postgres://app:s3cretpw@db:5432/app"]: "connection string with a password",
      ['password = "hunter22hunter"']: "credential assignment",
      [`${["sk", "ant", "api03"].join("-")}-${"x".repeat(24)}`]: "Anthropic API key",
      [`//registry.npmjs.org/:_authToken=${["npm", "_", "b".repeat(36)].join("")}`]: "npm token",
      ["DATABASE_PASSWORD=s3cretpassword"]: "credential assignment",
      ["export API_KEY=abcdef123456"]: "credential assignment",
      ["//registry.example.com/:_authToken=abcdef0123456789"]: "credential assignment",
    };
    for (const [line, rule] of Object.entries(flagged)) {
      assert.ok(contentRules(line).includes(rule), `${rule}: ${line.slice(0, 12)}`);
    }
    for (const line of [
      "const url = process.env.DATABASE_URL;",
      "postgres://localhost:5432/app",
      "password: z.string().min(8),",
      "const token = createToken(user);",
      "TOKEN_TTL=3600",
      ["DATABASE_PASSWORD=", "$", "{DB_PASSWORD}"].join(""),
    ]) {
      assert.deepEqual(contentRules(line), [], line);
    }
  });

  it("reads added lines, their numbers and binary files from a -U0 patch", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,0 +3,2 @@",
      "+one",
      "+two",
      "diff --git a/img.png b/img.png",
      "Binary files /dev/null and b/img.png differ",
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
    ].join("\n");
    assert.deepEqual(parsePatch(patch), [
      {
        path: "a.txt",
        binary: false,
        added: [
          { line: 3, text: "one" },
          { line: 4, text: "two" },
        ],
      },
      { path: "img.png", binary: true, added: [] },
      { path: "gone.txt", binary: false, added: [] },
    ]);
  });

  it("inspects an added line that looks like a diff header inside a hunk", () => {
    // Content "++ b/x" is added as "+++ b/x"; content "-- a/y" is removed as "--- a/y".
    const patch = [
      "diff --git a/s.txt b/s.txt",
      "--- a/s.txt",
      "+++ b/s.txt",
      "@@ -1 +1 @@",
      "--- a/y",
      `+++ b/${FAKE_AWS}`,
    ].join("\n");
    const [file] = parsePatch(patch);
    assert.equal(file?.path, "s.txt");
    assert.deepEqual(file?.added, [{ line: 1, text: `++ b/${FAKE_AWS}` }]);
  });

  it("names commit, place and rule, and never the matched text", () => {
    const findings = inspectCommits([
      {
        sha: "a".repeat(40),
        message: `fix: use ${FAKE_GITHUB}`,
        paths: ["src/x.ts", ".github/workflows/x.yml"],
        files: [{ path: "src/x.ts", binary: false, added: [{ line: 7, text: FAKE_AWS }] }],
      },
    ]);
    assert.deepEqual(
      findings.map(({ where, rule }) => `${where}: ${rule}`),
      [
        "commit message: GitHub token",
        ".github/workflows/x.yml: .github/ file",
        "src/x.ts:7: AWS access key",
      ],
    );
    assert.ok(!JSON.stringify(findings).includes(FAKE_AWS));
  });

  it("strips URL credentials and control characters from what it prints", () => {
    assert.equal(
      printable("fatal: https://user:t0ken@example.com/x.git\u001b[2J"),
      "fatal: https://***@example.com/x.git?[2J",
    );
  });
});

// --- The CLI against real repositories -----------------------------------------------------------

const git = (dir, ...args) => {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repository whose main is on a bare remote, and a local branch `work` with `files` on top. */
function setup(files, { onRemote = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ralph-push-inspect-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", remote);
  mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  const commit = (message, content) => {
    for (const [path, text] of Object.entries(content)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
  };
  commit("init", { "README.md": "demo\n", ...onRemote });
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "switch", "--quiet", "-c", "work");
  commit("wip(ralph): rejected", files);
  return { repo, remote };
}

const inspect = (repo, ...args) =>
  spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });

describe("the push inspection CLI", () => {
  it("passes clean commits the remote lacks (exit 0)", () => {
    const { repo } = setup({ "src/feature.ts": "export const x = 1;\n" });
    const result = inspect(repo, "--ref", "refs/heads/work", "--remote", "origin");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /passed, 1 commit\(s\) inspected/);
  });

  it("blocks a planted credential without printing it (exit 1)", () => {
    const { repo } = setup({ "src/config.ts": `export const key = "${FAKE_AWS}";\n` });
    const result = inspect(repo, "--ref", "refs/heads/work", "--remote", "origin");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/config\.ts:1: AWS access key/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_AWS));
  });

  it("blocks a workflow file (exit 1)", () => {
    const { repo } = setup({ ".github/workflows/x.yml": "on: push\n" });
    const result = inspect(repo, "--ref", "refs/heads/work", "--remote", "origin");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.github\/workflows\/x\.yml: \.github\/ file/);
  });

  it("inspects only what the push would send, not what the remote already has", () => {
    const { repo } = setup(
      { "src/feature.ts": "export const x = 1;\n" },
      { onRemote: { ".github/workflows/ci.yml": "on: push\n" } },
    );
    const result = inspect(repo, "--ref", "refs/heads/work", "--remote", "origin");
    assert.equal(result.status, 0, result.stderr);
  });

  it("blocks when it cannot decide: no such ref, unreachable remote, bad usage (exit 2)", () => {
    const { repo, remote } = setup({ "src/feature.ts": "x\n" });
    for (const args of [
      ["--ref", "refs/heads/missing", "--remote", "origin"],
      ["--ref", "refs/heads/work", "--remote", join(remote, "..", "nowhere.git")],
      ["--ref", "refs/heads/work"],
    ]) {
      const result = inspect(repo, ...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /could not run, so the push is blocked/);
    }
  });
});
