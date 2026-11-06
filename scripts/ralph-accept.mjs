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
//     skills, the root package.json scripts, every package's gate and install scripts), Git
//     attributes or submodules, or add a symlink or submodule. So the host scripts the batch
//     runs, and the definition of the gate the agent is judged by, cannot change through a run.
//   - What runs in a trusted role while the gate judges the slice is fixed by the base (ADR 0015):
//     test and build configuration, the test infrastructure, Prisma generators, and the
//     toolchain's locked dependencies (lockfileErrors).
//   - The full quality gate passes again on the merged tree, in hardened staged containers with no
//     agent (RALPH_ACCEPT_VERIFY, scripts/ralph-verify.mjs); its verdict is their exit status.
//   - The host's own Standards and Spec reviewers, each in an isolated read-only container with a
//     snapshot of exactly the slice commit, approve it (scripts/ralph-host-review.mjs). Nothing the
//     agent's container produced about its reviews is read. Not approved: the host blocks the
//     ticket in its own commit and keeps the slice on rejected/<slug>-<run> (exit 1). A provider
//     cut-off leaves the host unchanged (exit 1). Approved: the host records the review's deferred
//     findings in the register in its own commit.
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
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { isMap, isScalar, parse, parseAllDocuments, visit } from "yaml";
import { cleanup, initRoot, markRun, redactRun, secretValues } from "./ralph-artifacts.mjs";
import {
  checkRegisterText,
  parseRegister,
  recordFindings,
  renderRegister,
  validateRegister,
} from "./ralph-debt.mjs";
import { hostReview } from "./ralph-host-review.mjs";
import { isToolchain, TOOLCHAIN_IMPORTERS } from "./ralph-toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const BASE = env.RALPH_BASE_BRANCH || "main";
const VERIFY = env.RALPH_ACCEPT_VERIFY ?? "bash scripts/sandbox.sh --verify";
const MAX_ATTEMPTS = Number(env.RALPH_MAX_ATTEMPTS || 5);
const MAX_ROUNDS = Number(env.RALPH_MAX_REVIEW_ROUNDS || 3);
const LOG_ROOT = join(root, ".ralph/logs");
// Host-written only: the container's logs are imported under .ralph/logs/<run id>, never here.
const REVIEW_ROOT = join(root, ".ralph/host-review");
const REGISTER = "docs/technical-debt.md";
const STATE_DIR = join(root, ".ralph/state");
const PAUSED_EXIT = 75;
const UNTRUSTED_EXIT = 3;
const ZERO = "0".repeat(40);
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;

// The harness, everything that defines its gate, and what the host runs from the repository
// (install hooks, the local services): a slice that changes any of it could change what judges
// the next slice, or what runs on the host. Changing it takes a human-reviewed commit. Names are
// compared folded (see `fold`), so they are listed in lower case.
export const PROTECTED_FILES = [
  "ralph-loop.sh",
  "dockerfile",
  ".dockerignore",
  "tsconfig.base.json",
  "turbo.json",
  "docker-compose.yml",
  ".nvmrc",
];
// packages/test-infra holds the Vitest global setup, which runs inside the Vitest main process
// that reports the test verdict (ADR 0015), so it is part of the gate's runner, not of a slice.
export const PROTECTED_DIRS = [
  "scripts/",
  ".github/",
  "skills/",
  "docs/workflow/",
  "infra/",
  "packages/test-infra/",
];
// Anywhere in the tree: Biome and Turborepo read nested configuration, pnpm nested settings
// (`scriptShell` in a package's pnpm-workspace.yaml changes what its scripts run) and manifests in
// any of its formats (only package.json is judged by its content, below), node-gyp builds any
// package with a binding.gyp on install, and Claude Code loads .mcp.json.
const NESTED_GATE_FILES = [
  "biome.json",
  "biome.jsonc",
  "turbo.json",
  "turbo.jsonc",
  ".npmrc",
  // The host-only rule below reads the host's own ignore rules: a slice that could drop or negate
  // one in an earlier run would open that path for a later one.
  ".gitignore",
  "pnpm-workspace.yaml",
  ".mcp.json",
  "package.yaml",
  "package.json5",
  "binding.gyp",
  // Biome can take its formatting from it.
  ".editorconfig",
];
// Anywhere in the tree, by name: pnpm hooks in any module format, Docker Compose files (an
// override is merged in by itself, and `compose.yaml` wins over `docker-compose.yml`), and what
// Claude Code and editors load by themselves for host sessions and for the next agent and its
// reviewers (CLAUDE.md, CLAUDE.local.md, .claude/, .vscode/, .idea/).
//
// And the configuration that runs, or decides what runs, inside the verifier's trusted processes
// (ADR 0015): Vitest and Vite configuration executes in the Vitest main process, which reports
// the verdict, and so do the PostCSS and Tailwind configuration Vite loads for stylesheets;
// `prisma.config.*` executes when the client is generated; `tsconfig*.json` decides what the type
// check covers.
const NESTED_GATE_NAMES = [
  /^\.pnpmfile\./,
  /^(docker-)?compose([.-].*)?\.ya?ml$/,
  /^claude(\.local)?\.md$/,
  /^vite(st)?\.(config|workspace|projects)(\.|$)/,
  /^(postcss|tailwind)\.config\./,
  /^\.postcssrc/,
  /^prisma\.config\./,
  /^[tj]sconfig(\..*)?\.json$/,
];
const NESTED_GATE_DIRS = [".claude", ".vscode", ".idea"];
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
// Paths and ref names in messages come from the container: C0 and C1 control characters are
// masked so they cannot rewrite the operator's terminal.
const printable = (text) =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code < 160) ? "?" : char;
    })
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

/**
 * Whether `sha`'s own tree holds a regular file at exactly `path`: what a RESOLVED debt entry's
 * Verification must name. Judged in the candidate, not the host's checkout, because the slice may
 * add the test itself and an ignored host file must never vouch for it. A read-only object lookup
 * with literal pathspecs, so `*` or `:(glob)` match nothing; directories and symlinks do not count.
 */
function fileInTree(sha) {
  return (path) => {
    const result = git(["--literal-pathspecs", "ls-tree", "-z", sha, "--", path]);
    const [entry = ""] = result.stdout.split("\0");
    const match = /^(100644|100755) blob [0-9a-f]+\t(.*)$/s.exec(entry);
    return result.status === 0 && match !== null && match[2] === path;
  };
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

// The name a path has on the most forgiving file system the host may use. Windows and macOS
// fold case and Unicode forms, and Windows drops trailing dots and spaces, so `Scripts/x.sh`,
// `scripts./x.sh` and `scripts/x.sh` are one file there. Every rule compares folded names.
const fold = (path) =>
  path
    // HFS+ ignores these when it looks a name up, so `scripts\u200c/x` is `scripts/x` there.
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFC")
    // Upper then lower approximates full case folding: `ſ` and `K` (Kelvin) become `s` and `k`.
    .toUpperCase()
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[. ]+$/, ""))
    .join("/");
function isProtected(folded) {
  const parts = folded.split("/");
  const name = parts.at(-1) ?? "";
  return (
    PROTECTED_FILES.includes(folded) ||
    PROTECTED_DIRS.some((dir) => folded.startsWith(dir)) ||
    NESTED_GATE_FILES.includes(name) ||
    NESTED_GATE_NAMES.some((pattern) => pattern.test(name)) ||
    parts.slice(0, -1).some((part) => NESTED_GATE_DIRS.includes(part))
  );
}
// Names Windows resolves to something else: 8.3 short names (`SCRIPT~1` can open `scripts`),
// stream syntax, device names (`aux.ts` is the AUX device) and characters it cannot store.
const UNPORTABLE =
  /~\d|[\\:*?"<>|]|^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/;
const hasControl = (text) => printable(text) !== text;

// The scripts that make up the gate, in any package. A slice may add a package or change its
// dependencies, but not redefine what `lint`, `typecheck` or `test` run for an existing one.
// `db:generate` is one too: the gate's typecheck and test tasks depend on it (turbo.json), and the
// verifier runs it while it prepares the workspace.
const GATE_SCRIPTS = [
  "lint",
  "typecheck",
  "test",
  "check",
  "check:debt",
  "test:harness",
  "db:generate",
].flatMap((name) => [name, `pre${name}`, `post${name}`]);
// What pnpm runs by itself on `pnpm install` for every workspace package, before any gate and on
// every developer machine: no package may gain one, new packages included.
const INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "pnpm:devPreinstall",
];
// The root manifest also pins the package manager, the engines and pnpm's own settings: a slice
// may change only its dependencies there.
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const UNPARSEABLE = Object.freeze({});
/** The manifest at `path` on `sha`: null if absent, UNPARSEABLE if it is not a JSON object. */
function manifest(sha, path) {
  const text = show(sha, path);
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Reported below like any other manifest that is not an object.
  }
  return UNPARSEABLE;
}
const pick = (object, names) =>
  Object.fromEntries(Object.entries(object ?? {}).filter(([name]) => names.includes(name)));
const omit = (object, names) =>
  Object.fromEntries(Object.entries(object ?? {}).filter(([name]) => !names.includes(name)));

function scriptsError(from, to, path) {
  const before = manifest(from, path);
  const after = manifest(to, path);
  if (after === UNPARSEABLE) {
    return "not a JSON object, so pnpm and this check could read it differently";
  }
  if (before !== null && after === null) {
    return "removing a package removes its tests from the gate";
  }
  const scripts = (pkg) => (pkg === UNPARSEABLE ? {} : (pkg?.scripts ?? {}));
  if (
    !isDeepStrictEqual(
      pick(scripts(before), INSTALL_SCRIPTS),
      pick(scripts(after), INSTALL_SCRIPTS),
    )
  ) {
    return "install scripts cannot change through a run";
  }
  if (before === null || before === UNPARSEABLE) {
    return newPackageError(from, scripts(after));
  }
  // The root manifest is the gate and the host's tooling: only its dependencies may change.
  const same =
    path === "package.json"
      ? isDeepStrictEqual(omit(before, DEPENDENCY_FIELDS), omit(after, DEPENDENCY_FIELDS))
      : isDeepStrictEqual(pick(scripts(before), GATE_SCRIPTS), pick(scripts(after), GATE_SCRIPTS));
  return same ? null : "the scripts and settings that define the gate cannot change through a run";
}

/** The commands the base's packages run for each gate script, by script name. */
function baseGateCommands(sha) {
  const commands = new Map();
  const manifests = gitOut("ls-tree", "-r", "-z", "--name-only", sha)
    .split("\0")
    .filter((path) => path.endsWith("/package.json"));
  for (const path of manifests) {
    const pkg = manifest(sha, path);
    for (const [name, command] of Object.entries(pick(pkg?.scripts, GATE_SCRIPTS))) {
      commands.set(name, [...(commands.get(name) ?? []), command]);
    }
  }
  return commands;
}

/**
 * A new package's lint, typecheck and db:generate (and their pre/post scripts) run in the
 * verifier's install and tools stages, whose workspace every later stage trusts. So each must run
 * a command some package of the base already runs under that name. Only `test` is the package's
 * own: it runs in the test stage, offline and read-only, in a container of its own.
 */
function newPackageError(from, scripts) {
  const allowed = baseGateCommands(from);
  const foreign = Object.entries(pick(scripts, GATE_SCRIPTS))
    .filter(([name, command]) => name !== "test" && !(allowed.get(name) ?? []).includes(command))
    .map(([name]) => name);
  return foreign.length === 0
    ? null
    : `a new package's gate scripts (${foreign.join(", ")}) must run what the base's packages run; its own code runs only in its tests`;
}

// A Prisma `generator` names a program that `prisma generate` runs (its `provider` may be any
// command), and the verifier generates the client before any test. Slices change models, never
// generators. Comments are dropped first; a `generator` keyword the block pattern does not account
// for (written some other way) counts as a change, so the comparison fails closed.
function generators(text) {
  const code = (text ?? "").replace(/\r/g, "").replace(/\/\/[^\n]*/g, "");
  const blocks = (code.match(/\bgenerator\s+\w+\s*\{[^}]*\}/g) ?? []).map((block) =>
    block.replace(/\s+/g, " "),
  );
  return { blocks, keywords: (code.match(/\bgenerator\b/g) ?? []).length };
}
function schemaError(from, to, path) {
  const before = generators(show(from, path));
  const after = generators(show(to, path));
  return isDeepStrictEqual(before, after)
    ? null
    : "Prisma generators run programs when the client is generated; they cannot change through a run";
}

// --- The toolchain's locked dependencies (ADR 0015) ----------------------------------------------

// What the toolchain is: scripts/ralph-toolchain.mjs. Its locked versions and every locked
// dependency beneath them must stay those of the base, so a slice cannot swap in code that judges it.
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const packageName = (key) => /^(@[^/@]+\/[^@]+|[^@]+)@/.exec(key)?.[1] ?? key;

/**
 * The lockfile's YAML documents, each with its source text and top-level entries. pnpm reads the
 * file with a different YAML parser, so everything the two could read differently is refused:
 * aliases, tags and merge keys. Entries are compared by their source text, never by parsed value.
 */
function lockDocuments(text) {
  const parsed = parseAllDocuments(text, { uniqueKeys: true, strict: true, merge: false });
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((doc) => {
    if (doc.errors.length > 0) {
      throw new Error(`not valid YAML: ${doc.errors[0].message.split("\n")[0]}`);
    }
    visit(doc, {
      Alias() {
        throw new Error("YAML aliases are not allowed");
      },
      Pair(_, pair) {
        if (isScalar(pair.key) && pair.key.value === "<<") {
          throw new Error("YAML merge keys are not allowed");
        }
      },
      Node(_, node) {
        if (node.tag !== undefined || node.anchor !== undefined) {
          throw new Error("YAML tags and anchors are not allowed");
        }
      },
    });
    const source = (node) => (node?.range ? text.slice(node.range[0], node.range[1]) : "");
    const entries = (node) =>
      new Map(
        (isMap(node) ? node.items : []).map((pair) => [
          String(isScalar(pair.key) ? pair.key.value : source(pair.key)),
          { node: pair.value, text: source(pair.value).replace(/\r/g, "") },
        ]),
      );
    const top = entries(doc.contents);
    return {
      text: source(doc.contents).replace(/\r/g, ""),
      top,
      packages: entries(top.get("packages")?.node),
      snapshots: entries(top.get("snapshots")?.node),
      importers: doc.toJS()?.importers ?? {},
    };
  });
}

/** Changes to anything but the dependency entries: pnpm's own entry, settings, overrides. */
function headerErrors(before, after) {
  const errors = [];
  // pnpm's own entry (the package manager it switches to) lives in the leading documents.
  if (before.slice(0, -1).some((doc, i) => doc.text !== after[i].text)) {
    errors.push("the package manager's locked entry cannot change through a run");
  }
  const [base, next] = [before.at(-1), after.at(-1)];
  const entries = ["importers", "packages", "snapshots"];
  for (const [key, entry] of base.top) {
    if (!entries.includes(key) && next.top.get(key)?.text !== entry.text) {
      errors.push(`its ${key} cannot change through a run`);
    }
  }
  for (const key of next.top.keys()) {
    if (!base.top.has(key)) {
      errors.push(`its ${key} cannot be added through a run`);
    }
  }
  return errors;
}

/** An entry both sides lock is the same package: it may be dropped, never redefined. */
function redefinedErrors(base, next) {
  return ["packages", "snapshots"].flatMap((section) =>
    [...base[section]]
      .filter(([key, entry]) => {
        const now = next[section].get(key);
        return now !== undefined && now.text !== entry.text;
      })
      .map(([key]) => `${key} is locked differently than on the base`),
  );
}

/** Every [importer, name, locked version] an importers section resolves. */
function resolutions(importers) {
  return Object.entries(importers).flatMap(([importer, sections]) =>
    DEPENDENCY_SECTIONS.flatMap((section) =>
      Object.entries(sections?.[section] ?? {}).map(([name, dep]) => [
        importer,
        name,
        String(dep?.version ?? ""),
      ]),
    ),
  );
}
// A `link:` version is a directory relative to its importer: a workspace package or any other.
const linkTarget = (importer, version) =>
  version.startsWith("link:") ? posix.normalize(posix.join(importer, version.slice(5))) : null;

/** Why one toolchain resolution is not the base's, or null. */
function resolutionError(importer, name, version, base, baseLinks) {
  // A link resolves the name to a directory of the slice: only where the base links it too.
  const target = linkTarget(importer, version);
  if (target !== null) {
    return baseLinks.has(`${name}\0${target}`)
      ? null
      : `${importer} links ${name} to ${target}, which the base does not`;
  }
  // An aliased dependency names its target package in the version itself.
  const key = /^(@[^/@]+\/[^@]+|[^@(]+)@/.test(version) ? version : `${name}@${version}`;
  return base.snapshots.has(key)
    ? null
    : `${importer} resolves ${name} to ${key}, which the base does not lock`;
}

/** Toolchain dependencies must resolve to what the base resolves them to, so they bring its closure. */
function toolchainErrors(base, next) {
  const baseLinks = new Set(
    resolutions(base.importers)
      .filter(([importer, , version]) => linkTarget(importer, version) !== null)
      .map(([importer, name, version]) => `${name}\0${linkTarget(importer, version)}`),
  );
  return resolutions(next.importers)
    .filter(([importer, name]) => TOOLCHAIN_IMPORTERS.includes(importer) || isToolchain(name))
    .map(([importer, name, version]) => resolutionError(importer, name, version, base, baseLinks))
    .filter((error) => error !== null);
}

/** Why the lockfile change between two commits could alter the toolchain, or an empty list. */
function lockfileErrors(from, to, allowBuilds) {
  let before;
  let after;
  try {
    before = lockDocuments(show(from, "pnpm-lock.yaml") ?? "");
    after = lockDocuments(show(to, "pnpm-lock.yaml") ?? "");
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (before.length === 0 || before.length !== after.length) {
    return ["the lockfile's documents cannot be added or removed through a run"];
  }
  const [base, next] = [before.at(-1), after.at(-1)];
  // pnpm runs build scripts by package name: a new version of one is new code run at install.
  const builds = [...next.packages.keys()]
    .filter((key) => allowBuilds.includes(packageName(key)) && !base.packages.has(key))
    .map((key) => `${key} runs build scripts at install, and the base does not lock it`);
  return [
    ...headerErrors(before, after),
    ...redefinedErrors(base, next),
    ...toolchainErrors(base, next),
    ...builds,
  ];
}

/** The packages pnpm-workspace.yaml (protected) allows to run build scripts. */
function allowedBuilds(sha) {
  try {
    const config = parse(show(sha, "pnpm-workspace.yaml") ?? "") ?? {};
    return [
      ...Object.keys(config.allowBuilds ?? {}),
      ...(Array.isArray(config.onlyBuiltDependencies) ? config.onlyBuiltDependencies : []),
    ].map(String);
  } catch {
    return [];
  }
}

// What is wrong with one change, or null. `issues` judges a change under issues/ (true = allowed).
function changeError({ path, newMode, status }, issues) {
  const folded = fold(path);
  const parts = folded.split("/");
  if (hasControl(path) || parts.some((part) => UNPORTABLE.test(part))) {
    return "not a portable path name";
  }
  if (parts.includes(".git")) {
    return "a .git path component";
  }
  if (GIT_METADATA.includes(parts.at(-1) ?? "")) {
    return "Git attributes and submodules cannot change through a run";
  }
  if (isProtected(folded)) {
    return "protected harness or gate file";
  }
  if (status !== "D" && (newMode === "120000" || newMode === "160000")) {
    return newMode === "120000" ? "symlink" : "submodule";
  }
  if (folded.startsWith("issues/") && !issues({ path, status })) {
    return "only the ticket's own file may change in issues/";
  }
  return null;
}

/** What is wrong with a change's content, for files whose content decides what runs. */
function contentError(from, to, path) {
  const name = fold(path).split("/").at(-1) ?? "";
  if (name === "package.json") {
    return scriptsError(from, to, path);
  }
  return name.endsWith(".prisma") ? schemaError(from, to, path) : null;
}

/** Problems with the changes between two commits, whoever made them. */
export function pathErrors(from, to, issues) {
  const errors = [];
  const list = changes(from, to);
  const hostOnly = hostOnlyPaths(list.filter((change) => change.status !== "D"));
  for (const change of list) {
    const error =
      changeError(change, issues) ??
      (hostOnly.has(change.path)
        ? "the host keeps this path out of Git (state, credentials, dependencies)"
        : null) ??
      contentError(from, to, change.path);
    if (error) {
      errors.push(`${change.path}: ${error}`);
    }
  }
  const lockfile = list.find((change) => fold(change.path) === "pnpm-lock.yaml");
  if (lockfile) {
    for (const problem of lockfileErrors(from, to, allowedBuilds(from))) {
      errors.push(`${lockfile.path}: ${problem}`);
    }
  }
  return errors;
}

// Paths the host itself never tracks, whatever a slice does to .gitignore first.
const HOST_ONLY_DIRS = [".ralph", "node_modules", ".pnpm-store", ".turbo"];
const isEnvFile = (name) => /^\.env(\..*)?$/.test(name) && !name.endsWith(".example");

/**
 * The changed paths that would land on files the host keeps out of Git: its batch and resume
 * state, credentials, installed dependencies. A fast-forward overwrites ignored files without a
 * trace in `git status`, so such a path could plant state or executables the host then trusts.
 * Judged by the host's own ignore rules (the base's .gitignore files, info/exclude, the user's
 * excludes), on both the path and its folded spelling, plus a fixed list.
 */
function hostOnlyPaths(list) {
  const found = new Set();
  const byCandidate = new Map();
  for (const { path } of list) {
    const parts = fold(path).split("/");
    if (parts.some((part) => HOST_ONLY_DIRS.includes(part)) || isEnvFile(parts.at(-1) ?? "")) {
      found.add(path);
    }
    byCandidate.set(path, path);
    byCandidate.set(fold(path), path);
  }
  if (byCandidate.size > 0) {
    const result = git(["check-ignore", "--no-index", "--stdin", "-z"], {
      input: `${[...byCandidate.keys()].join("\0")}\0`,
    });
    if (result.status > 1) {
      throw new Error(`git check-ignore failed: ${result.stderr.trim()}`);
    }
    for (const candidate of result.stdout.split("\0").filter(Boolean)) {
      found.add(byCandidate.get(candidate) ?? candidate);
    }
  }
  return found;
}

/**
 * Refuses a tree in which two paths name the same file once folded. A case-insensitive checkout
 * would write both to one place, and the later one would silently replace the earlier, whatever
 * the path rules decided about each.
 */
function assertNoCollisions(sha, what) {
  const spelled = new Map();
  for (const path of gitOut("ls-tree", "-r", "-z", "--name-only", sha).split("\0")) {
    const parts = path.split("/");
    for (let end = 1; path !== "" && end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join("/");
      const other = spelled.get(fold(prefix));
      if (other !== undefined && other !== prefix) {
        refuse(`${what}: ${other} and ${prefix} are the same file on a case-insensitive host`);
      }
      spelled.set(fold(prefix), prefix);
    }
  }
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
  assertNoCollisions(tip, BASE);
  return outcomes;
}

// Untrusted output must be what it claims: a FIFO named result.bundle would hang the host, and a
// linked state/ or logs/ would read from wherever it points.
function plain(path, kind) {
  if (!existsSync(path) && lstatSafe(path) === null) {
    return false;
  }
  const stat = lstatSafe(path);
  const ok = kind === "file" ? stat?.isFile() : stat?.isDirectory() && !stat.isSymbolicLink();
  if (!ok) {
    refuse(`${basename(path)} is not a plain ${kind === "file" ? "file" : "directory"}`);
  }
  return true;
}
function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
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
  if (!plain(dir, "directory")) {
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
    assertNoCollisions(fields.paused, fields.ref);
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
    } else if (stat.isFile() && stat.size > MAX_LOG_BYTES) {
      log(`dropped ${name} from the logs: larger than ${MAX_LOG_BYTES} bytes`);
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

/** Copies the run's logs in and returns the host directories they landed in. */
function importLogs(outDir) {
  const imported = [];
  try {
    initRoot(LOG_ROOT);
    // Left behind by an import that was killed: container-written and possibly unredacted.
    for (const name of readdirSync(LOG_ROOT).filter((entry) => entry.endsWith(".importing"))) {
      rmSync(join(LOG_ROOT, name), { recursive: true, force: true });
    }
    const logs = join(outDir, "logs");
    if (!lstatSafe(logs)?.isDirectory()) {
      log("the run left no plain logs/ directory; no logs imported");
      return imported;
    }
    const runs = readdirSync(logs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
      .map((entry) => entry.name);
    for (const run of runs) {
      const target = join(LOG_ROOT, run);
      // Merging into a run the host already has would mix the container's files into its
      // evidence, so such a run is not imported at all.
      if (lstatSafe(target) !== null) {
        log(`skipped logs/${run}: the host already has logs for that run`);
      } else {
        // Staged next to the target and renamed into place once complete, so a copy that fails
        // halfway leaves nothing behind: no unredacted file, no container run.json.
        const staging = `${target}.importing`;
        rmSync(staging, { recursive: true, force: true });
        try {
          copyLogs(join(logs, run), staging);
          // Retention is decided from run.json, so the host writes its own with its verdict.
          rmSync(join(staging, "run.json"), { force: true });
          redactRun(staging, secretValues(env));
          renameSync(staging, target);
          imported.push(target);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      }
      // The run directory is kept after a refusal: only the bounded, redacted copy remains.
      rmSync(join(logs, run), { recursive: true, force: true });
    }
  } catch (error) {
    // Evidence only: a broken log never decides, and never hides, a run's outcome.
    log(`could not import every log: ${error instanceof Error ? error.message : String(error)}`);
  }
  return imported;
}

function recordLogs(imported, verdict) {
  const status = { 0: "succeeded", [PAUSED_EXIT]: "paused" }[verdict.exit] ?? "failed";
  try {
    for (const dir of imported) {
      markRun(dir, status);
    }
    cleanup({ reviewRoot: join(root, ".ralph/review"), logRoot: LOG_ROOT });
  } catch (error) {
    log(`could not record the logs: ${error instanceof Error ? error.message : String(error)}`);
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

// Bundle fetches skip fetch.fsckObjects (Git 2.45), and an object that reached the host's store
// would stay there after a refusal and fail every later check. So the bundle is first fetched
// into a scratch repository that borrows the host's objects through an alternate, and only the
// objects the bundle adds are checked there, strictly, before the host fetches anything.
function assertWellFormed(bundle) {
  const scratch = mkdtempSync(join(tmpdir(), "ralph-accept-objects-"));
  try {
    // Named explicitly, never discovered: safe.bareRepository=explicit forbids discovery.
    const inScratch = (args) => git([`--git-dir=${scratch}`, ...args], { cwd: scratch });
    const init = git(["init", "--quiet", "--bare", scratch]);
    if (init.status !== 0) {
      throw new Error(`could not create a scratch repository: ${init.stderr.trim()}`);
    }
    const objects = gitOut("rev-parse", "--path-format=absolute", "--git-path", "objects");
    writeFileSync(join(scratch, "objects", "info", "alternates"), `${objects}\n`);
    // Unbundling always keeps a pack today; unpackLimit 1 keeps it so if that ever changes, since
    // the check below reads packs only.
    const fetched = inScratch([
      "-c",
      "fetch.unpackLimit=1",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      bundle,
      "+refs/heads/*:refs/check/*",
    ]);
    if (fetched.status !== 0) {
      refuse(`result.bundle could not be read: ${fetched.stderr.trim()}`);
    }
    const added = readdirSync(join(scratch, "objects", "pack")).filter((name) =>
      name.endsWith(".pack"),
    );
    for (const pack of added) {
      const checked = inScratch([
        "index-pack",
        "--strict",
        "--fsck-objects",
        "-o",
        join(scratch, `${pack}.check.idx`),
        join(scratch, "objects", "pack", pack),
      ]);
      if (checked.status !== 0) {
        refuse(`result.bundle holds malformed objects: ${checked.stderr.trim().split("\n")[0]}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function fetchBundle(bundle, namespace) {
  if (git(["bundle", "verify", "--quiet", bundle]).status !== 0) {
    refuse("result.bundle is not a valid Git bundle for this repository");
  }
  assertWellFormed(bundle);
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

/**
 * The host's own review of every slice the run merged (scripts/ralph-host-review.mjs), in order.
 * Stops at the first that is not approved. For the approved ones, the register as the host
 * records their deferred findings, or null when it has nothing to add.
 */
function reviewMerges(merges, { base, label }) {
  const findings = [];
  for (const { slug, slice } of merges) {
    const result = hostReview({
      base: parents(slice)[0],
      slice,
      ticket: `issues/done/${slug}.md`,
      logDir: join(REVIEW_ROOT, label, slug),
      workDir: join(root, ".ralph", "sandbox", `review-${label}`),
      label: `${label}-${slug.slice(0, 2)}`,
    });
    if (result.verdict !== "approved") {
      return { rejected: { slug, slice, verdict: result.verdict, reason: result.reason } };
    }
    findings.push({
      slug,
      findings: result.decision.findings ?? [],
      blocking: result.decision.blocking,
    });
  }
  // The register's evidence is judged in this one commit, here and again before the host commits it.
  const evidence = merges.at(-1).merge;
  return { register: recordHostFindings(evidence, base, findings, label), evidence };
}

/**
 * The run's register with the host review's deferred findings added. The base's entries must all
 * still be there: an agent that drops one hides debt, which is a forgery, not a review result.
 */
function recordHostFindings(tip, base, reviews, label) {
  const text = show(tip, REGISTER);
  if (text === null) {
    return null;
  }
  const before = show(base, REGISTER);
  let register = parseRegister(text);
  const errors = [];
  for (const { slug, findings, blocking } of reviews) {
    const result = recordFindings(register, {
      findings,
      blocking,
      base: before === null ? undefined : parseRegister(before),
      source: {
        ticketLabel: `ticket ${slug.slice(0, 2)} (\`${slug}\`)`,
        ref: `ticket ${slug.slice(0, 2)} host review`,
        run: label,
        evidence: `.ralph/host-review/${label}/${slug}`,
        date: new Date().toISOString().slice(0, 10),
        justification:
          `Non-blocking under the merge policy (blocking: ${blocking.join(", ")}); ` +
          "deferred when the host's own review approved the ticket. Escalate if its real impact grows.",
      },
    });
    errors.push(...result.errors);
    register = result.register;
  }
  errors.push(...validateRegister(register, { exists: fileInTree(tip) }));
  if (errors.length > 0) {
    refuse(`the debt register: ${errors.join("; ")}`);
  }
  const rendered = renderRegister(register);
  return rendered === text ? null : rendered;
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
  // Only after everything deterministic passed: the review is the expensive, judged part.
  const review =
    merges.length > 0 ? reviewMerges(merges, { base, label: basename(namespace) }) : {};
  const blocked = outcomes.find((outcome) => outcome.kind === "blocked");
  const quarantines = [...incoming].filter(([name]) => {
    const match = /^rejected\/(\d{2}-[a-z0-9-]+)-\d{8}-\d{6}$/.exec(name);
    return match !== null && blocked?.slug === match[1];
  });
  return { incoming, tip, outcomes, pause, blocked, quarantines, review };
}

function clearNamespace(namespace) {
  for (const ref of gitOut("for-each-ref", "--format=%(refname)", `${namespace}/`).split("\n")) {
    if (ref !== "") {
      gitOut("update-ref", "-d", ref);
    }
  }
}

// The run stamp of a quarantine branch: the run directory's name starts with it.
const stampOf = (label) =>
  /^\d{8}-\d{6}/.exec(label)?.[0] ??
  new Date()
    .toISOString()
    .replace(/\D/g, "")
    .replace(/^(\d{8})(\d{6}).*/, "$1-$2");

/**
 * The host's review did not approve a slice: none of the run reaches the base branch. As
 * reject_slice does, the work is kept on a new quarantine branch and the ticket is blocked, here
 * in the host's own commit, so the batch stops on it as a rejection.
 */
function applyReviewRejection({ review }, { namespace }) {
  const { slug, slice, verdict } = review.rejected;
  const quarantine = `rejected/${slug}-${stampOf(basename(namespace))}`;
  createBranch(quarantine, slice);
  const file = `issues/${slug}.md`;
  const text = readFileSync(join(root, file), "utf8");
  writeFileSync(join(root, file), text.replace(/^(\*\*Status:\*\* ).*$/m, "$1blocked"));
  gitOut("add", "--", file);
  gitOut(
    "commit",
    "--quiet",
    "-m",
    `chore(issues): block ${file} after the host review`,
    "-m",
    `The host's isolated Standards and Spec review of slice/${slug} (${short(slice)}) was ` +
      `${verdict}, so the slice did not merge. It is preserved on ${quarantine}. ` +
      `Report: .ralph/host-review/${basename(namespace)}/${slug}/review.md`,
  );
  clearNamespace(namespace);
  log(`ticket ${slug} blocked: the host review was ${verdict}; the work is on ${quarantine}`);
}

function apply({ tip, outcomes, pause, quarantines, review }, { base, namespace }) {
  if (tip !== base) {
    gitOut("merge", "--ff-only", "--no-overwrite-ignore", "--quiet", tip);
    // A checkout that does not match the accepted tree means the file system merged paths that
    // Git keeps apart. The validation above refuses every such tree it knows of; if one slips
    // through anyway, the host goes back to the base it vouched for.
    if (gitOut("status", "--porcelain") !== "") {
      gitOut("reset", "--quiet", "--hard", base);
      refuse(
        `the checkout of ${short(tip)} did not match its tree; ${BASE} is back at ${short(base)}`,
      );
    }
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
  if (review?.register) {
    // The host's review is the authoritative one, so its deferred findings reach the register in
    // the host's own commit, after the merge it approved.
    const errors = checkRegisterText(review.register, { exists: fileInTree(review.evidence) });
    if (errors.length > 0) {
      throw new Error(`the host review's register is invalid: ${errors.join("; ")}`);
    }
    writeFileSync(join(root, REGISTER), review.register);
    gitOut("add", "--", REGISTER);
    gitOut(
      "commit",
      "--quiet",
      "-m",
      "chore(debt): record the host review's deferred findings",
      "-m",
      `Findings of the host's isolated Standards and Spec review of ` +
        `${outcomes
          .filter((outcome) => outcome.kind === "merged")
          .map((outcome) => `slice/${outcome.slug}`)
          .join(", ")}. Reports: .ralph/host-review/${basename(namespace)}/`,
    );
    log("recorded the host review's deferred findings in the debt register");
  }
  clearNamespace(namespace);
}

function decide(runDir, run) {
  const outDir = join(runDir, "out");
  if (!plain(join(outDir, "result.bundle"), "file")) {
    log("the run produced no result.bundle; nothing to accept");
    return { exit: 1, outcome: "no-result" };
  }
  const plan = validate(outDir, run);
  const problem = hostReady(run.base);
  if (problem) {
    log(`${problem}; refusing to apply the run`);
    return { exit: 1, outcome: "host-changed" };
  }
  if (plan.review.rejected) {
    if (plan.review.rejected.verdict === "unavailable") {
      log(`the host review could not run: ${plan.review.rejected.reason}; nothing is applied`);
      return { exit: 1, outcome: "review-unavailable", reason: plan.review.rejected.reason };
    }
    applyReviewRejection(plan, run);
    return { exit: 1, outcome: "review-rejected" };
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
  const imported = importLogs(join(runDir, "out"));
  let verdict;
  try {
    verdict = decide(runDir, { base, status, only: values.ticket, namespace });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof Refusal) {
      log(`REFUSED: ${reason}`);
      log(`the host repository is unchanged; the result is kept in ${namespace}/ and ${runDir}`);
      verdict = { exit: UNTRUSTED_EXIT, outcome: "untrusted", reason };
    } else {
      // A failure while applying a validated result: whatever was applied is valid on its own
      // (main only moves by fast-forward to a validated tip), and the batch re-reads the
      // repository, so it never trusts this verdict for what happened.
      log(`ERROR while accepting the run: ${reason}`);
      verdict = { exit: 1, outcome: "apply-failed", reason };
    }
  }
  recordLogs(imported, verdict);
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
