#!/usr/bin/env node
//
// Sensitive-data inspection of rejected work before it may leave the machine (ADR 0021). Rejected
// work is unreviewed agent output: it is never pushed by default, and an operator's explicit,
// per-run authorization (ralph-loop.sh --push-rejected NN) is not enough on its own. This script
// must also pass on exactly the commits the push would send, the ones reachable from the ref that
// the remote does not already have:
//
//   node scripts/ralph-push-inspect.mjs --ref <ref> --remote <remote>
//
// It refuses (fails closed) on:
//   - a changed path that is a `.github/` file (workflows run with the repository's secrets), an
//     env file (`.env`, `.env.*`; only `.env.example` is allowed), or a key file (`*.pem`, `*.key`,
//     `*.p12`, `*.pfx`, `*.tfvars`, `id_rsa`, `id_ed25519`, ...) or a credential file (`.npmrc`,
//     `.netrc`, `.git-credentials`, `.pgpass`, `credentials.json`, `secrets.*`); `*.env` counts as env;
//   - an added line or a commit message that matches a credential pattern (private keys, cloud
//     and API tokens, JWTs, a connection string with a password, `password = "..."`);
//   - binary content, which it cannot read;
//   - anything that stops it from deciding: the remote cannot be listed, Git fails, the ref does not
//     exist.
//
// The patterns are deliberately broad and there is no allowlist: a false positive only keeps the
// work local, where it stays available for investigation. A finding names the commit, the file,
// the line and the rule, never the matched text, so the report itself cannot leak a secret.
//
// Exit: 0 passed (the push may go ahead), 1 findings, 2 the inspection could not run. Any status
// but 0 blocks the push.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHA = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 256 * 1024 * 1024;

/** Content rules: name and pattern. Patterns are tested per line; matches are never reported. */
export const CONTENT_RULES = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ["OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{16,}/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["connection string with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:[^\s@/'"]+@/i],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}/],
  // Quoted values in code and config; `_auth` and `_authToken` as .npmrc writes them.
  [
    "credential assignment",
    /(?:\b|_)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|auth)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  ],
  // Unquoted, as env files, shell exports and .npmrc write them.
  [
    "credential assignment",
    /^\s*(?:export\s+)?[A-Za-z0-9_./:-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|_auth|_authToken)[A-Za-z0-9_]*\s*=\s*[^\s"'$]{8,}/i,
  ],
];

const KEY_FILE = /\.(?:pem|key|p12|pfx|jks|keystore|tfvars)$|^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
// Files whose whole purpose is to hold credentials.
const CREDENTIAL_FILE =
  /^(?:\.npmrc|\.netrc|_netrc|\.git-credentials|\.pgpass|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;

/** Why a changed path may not be published, or null. */
export function pathRule(path) {
  const segments = path.split("/");
  const name = basename(path);
  if (segments.slice(0, -1).includes(".github")) {
    return ".github/ file";
  }
  if (/^\.env(?:\..*)?$|\.env$/i.test(name) && name.toLowerCase() !== ".env.example") {
    return "env file";
  }
  if (KEY_FILE.test(name)) {
    return "key file";
  }
  if (CREDENTIAL_FILE.test(name)) {
    return "credential file";
  }
  return null;
}

/** The names of the content rules `text` matches. */
export function contentRules(text) {
  return [
    ...new Set(CONTENT_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)),
  ];
}

/**
 * Added lines per file from a `git diff -U0` patch: [{ path, binary, added: [{ line, text }] }].
 * The path is the new name (the old one for a deletion, which adds nothing).
 */
export function parsePatch(patch) {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map(parseFileDiff);
}

// One file's part of the patch. Header lines (---, +++, Binary) count only before the first
// hunk: inside a hunk, an added line whose content starts with "++ " also begins with "+++ ", and
// it must be inspected like any other added line.
function parseFileDiff(chunk) {
  const [header = "", ...lines] = chunk.split("\n");
  // The header's new name, until the ---/+++ lines (absent for binary files) say it exactly.
  const file = { path: / b\/(.*)$/.exec(header)?.[1] ?? "", binary: false, added: [] };
  let line = 0;
  let inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (!inHunk) {
      readHeaderLine(file, raw);
    } else if (raw.startsWith("+")) {
      file.added.push({ line, text: raw.slice(1) });
      line += 1;
    }
  }
  return file;
}

function readHeaderLine(file, raw) {
  if (raw.startsWith("--- a/") || raw.startsWith("+++ b/")) {
    file.path = raw.slice(6);
  } else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
    file.binary = true;
  }
}

/** [where, rule] pairs for one commit; `where` is a path, a path and line, or "commit message". */
function commitFindings({ message, paths, files }) {
  const found = contentRules(message).map((rule) => ["commit message", rule]);
  for (const path of paths) {
    const rule = pathRule(path);
    if (rule !== null) {
      found.push([path, rule]);
    }
  }
  for (const file of files) {
    if (file.binary) {
      found.push([file.path, "binary content cannot be inspected"]);
    }
    for (const { line, text } of file.added) {
      found.push(...contentRules(text).map((rule) => [`${file.path}:${line}`, rule]));
    }
  }
  return found;
}

/**
 * Findings for commits shaped { sha, message, paths: [changed path], files: parsePatch(...) }.
 * A finding is { sha, where, rule }.
 */
export function inspectCommits(commits) {
  return commits.flatMap((commit) =>
    commitFindings(commit).map(([where, rule]) => ({ sha: commit.sha, where, rule })),
  );
}

// --- Reading the commits from Git ----------------------------------------------------------------

class Unavailable extends Error {}

// What reaches the terminal: printable ASCII only (paths are agent-controlled), and no URL
// credentials (Git's own errors may quote a remote URL with a token in it).
export const printable = (text) =>
  String(text)
    .replace(/\/\/[^/@\s]+@/g, "//***@")
    .replace(/[^ -~]/g, "?");

function git(args, input) {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    input,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    // Only Git's own first line: it names the failure without echoing repository content.
    const reason = (result.stderr ?? "").split("\n")[0] || String(result.error ?? "failed");
    throw new Unavailable(`git ${args[0]} failed: ${reason}`);
  }
  return result.stdout;
}

/** The commits `ref` would send to `remote`: reachable from it, not from anything the remote has. */
function commitsToPush(ref, remote) {
  const tip = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  const known = git(["ls-remote", remote])
    .split("\n")
    .map((row) => row.split("\t")[0] ?? "")
    .filter((sha) => SHA.test(sha));
  // A remote commit this repository does not have cannot exclude anything here; leaving it out
  // only makes the inspection cover more.
  const local = known.length
    ? git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${known.join("\n")}\n`)
        .split("\n")
        .filter((row) => row.endsWith(" commit"))
        .map((row) => row.split(" ")[0])
    : [];
  const input = [tip, ...local.map((sha) => `^${sha}`)].join("\n");
  return git(["rev-list", "--stdin"], `${input}\n`).split("\n").filter(Boolean);
}

function readCommit(sha) {
  const parent = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(" ")[1] ?? EMPTY_TREE;
  const diff = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
  return {
    sha,
    message: git(["log", "-1", "--format=%B", sha]),
    paths: git([...diff, "--name-only", "-z", parent, sha])
      .split("\0")
      .filter(Boolean),
    files: parsePatch(git([...diff, "-U0", parent, sha])),
  };
}

function main() {
  const { values } = parseArgs({
    options: { ref: { type: "string" }, remote: { type: "string" } },
  });
  if (!(values.ref && values.remote)) {
    throw new Unavailable("usage: ralph-push-inspect.mjs --ref <ref> --remote <remote>");
  }
  const commits = commitsToPush(values.ref, values.remote).map(readCommit);
  const findings = inspectCommits(commits);
  for (const { sha, where, rule } of findings) {
    console.error(`push inspection: ${sha.slice(0, 12)} ${printable(where)}: ${rule}`);
  }
  if (findings.length > 0) {
    console.error(
      `push inspection: BLOCKED, ${findings.length} finding(s) in ${commits.length} commit(s)`,
    );
    return 1;
  }
  console.error(`push inspection: passed, ${commits.length} commit(s) inspected`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `push inspection: could not run, so the push is blocked: ${printable(error instanceof Error ? error.message : error)}`,
    );
    process.exitCode = 2;
  }
}
