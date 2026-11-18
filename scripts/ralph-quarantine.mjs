#!/usr/bin/env node
//
// Quarantined rejected work on the HOST (TD-059): where it lives, how a candidate is named
// exactly, what the host's own record of a rejection must say, and the recovery hold that keeps
// an unreconciled rejection from being run again. Shared by scripts/ralph-replay.mjs (resolution
// and provenance), scripts/ralph-accept.mjs and scripts/ralph-batch.mjs (the hold), and usable
// by a human:
//
//   node scripts/ralph-quarantine.mjs list
//   node scripts/ralph-quarantine.mjs inspect <full ref>
//   node scripts/ralph-quarantine.mjs holds [--check]
//   node scripts/ralph-quarantine.mjs release --ticket <NN-slug> --expect <hold object> [--rerun]
//
// Namespaces, and what each one may be used for:
//   refs/ralph/rejected/<slug>-<run>   quarantine: replayable when the host recorded the rejection
//   refs/heads/rejected/<slug>-<run>   legacy quarantine branch (before WS1; runs outside the
//                                      sandbox): replayable under the same rule
//   rejected/<slug>-<run>              an alias naming exactly the two above, never Git's guessing
//   refs/ralph/incoming/<run>/...      a run's unvalidated output: listed, NEVER replayable
//   refs/remotes/<remote>/rejected/... a published copy: listed, NEVER replayable
//   refs/ralph/recovery/<slug>         a recovery hold (D2): no automated run while it exists
//   refs/ralph/replay/<replay id>/...  the replay's own scratch refs, the only ones it deletes
//
// Inspection is read-only: it reads objects and refs with plumbing, never checks anything out,
// never writes a ref or the index, and runs no diff driver or textconv filter (`--no-ext-diff
// --no-textconv`), so rejected content cannot execute through it.
//
// Exit: 0 done; 1 refused (the reason is printed), or `holds --check` found a hold.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { contentRules, parsePatch, pathRule, printable } from "./ralph-push-inspect.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const QUARANTINE_NS = "refs/ralph/rejected/";
export const LEGACY_NS = "refs/heads/rejected/";
export const INCOMING_NS = "refs/ralph/incoming/";
export const RECOVERY_NS = "refs/ralph/recovery/";
export const REPLAY_NS = "refs/ralph/replay/";
const ALIAS = "rejected/";
const PUBLISHED = /^refs\/remotes\/[^/]+\/rejected\//;

const SLUG = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
// <slug>-<yyyymmdd>-<hhmmss>: what the importer and ralph-loop.sh name quarantined work.
const SUFFIX = /^(\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*)-(\d{8}-\d{6})$/;
const SHA = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REPLAY_REF = /^refs\/ralph\/replay\/replay-\d{14}-\d+\/(?:main|slice)$/;

export class QuarantineRefusal extends Error {}
const refuse = (message) => {
  throw new QuarantineRefusal(printable(message));
};

// Never Git's ambiguous short-name guessing: every ref below is spelled out in full. Literal
// pathspecs and no fsmonitor, so nothing a candidate holds is read as pathspec magic or wakes a
// hook.
function git(repo, args, { input } = {}) {
  const result = spawnSync(
    "git",
    ["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args],
    { cwd: repo, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function gitOut(repo, args, options) {
  const result = git(repo, args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.split("\n")[0]}`);
  }
  return result.stdout.replace(/\n$/, "");
}

const FIELDS = "%(refname)%00%(objectname)%00%(objecttype)%00%(symref)";

/** Refs under the given prefixes as {ref, sha, type, symref}. */
function listRefs(repo, prefixes) {
  return gitOut(repo, ["for-each-ref", `--format=${FIELDS}`, ...prefixes])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", type = "", symref = ""] = line.split("\0");
      return { ref, sha, type, symref };
    });
}

/** Exactly `ref`, or null. A symbolic ref is reported as such even when its target is missing. */
function exactRef(repo, ref) {
  if (git(repo, ["symbolic-ref", "--quiet", ref]).status === 0) {
    return { ref, sha: "", type: "", symref: "symbolic" };
  }
  return listRefs(repo, [ref]).find((row) => row.ref === ref) ?? null;
}

function assertUsable(row) {
  if (row.symref) {
    refuse(`${row.ref} is a symbolic ref; a candidate must be a plain ref to one commit`);
  }
  if (row.type !== "commit") {
    refuse(`${row.ref} points to a ${row.type || "missing object"}, not a commit`);
  }
}

// --- Candidate resolution ---------------------------------------------------------------------

function parseName(name) {
  if (name === "" || /[^!-~]/.test(name)) {
    refuse(`${JSON.stringify(name)} is not a valid quarantine name`);
  }
  if (name.startsWith(INCOMING_NS)) {
    refuse(
      `${name} is an incoming ref, a run's unvalidated output: incoming refs are never replayable`,
    );
  }
  if (PUBLISHED.test(name)) {
    refuse(
      `${name} is a published remote-tracking copy: published copies are never replayable; replay the host's own quarantine ref`,
    );
  }
  const forms = [
    [QUARANTINE_NS, "quarantine"],
    [LEGACY_NS, "legacy"],
    [ALIAS, "alias"],
  ];
  const form = forms.find(([prefix]) => name.startsWith(prefix));
  if (!form) {
    refuse(
      `${name} is not in a quarantine namespace (${QUARANTINE_NS}, ${LEGACY_NS}, or the alias ${ALIAS}<name>)`,
    );
  }
  const suffix = name.slice(form[0].length);
  const match = SUFFIX.exec(suffix);
  if (!match) {
    refuse(`${name} is not a valid quarantine name (<NN-slug>-<yyyymmdd>-<hhmmss>)`);
  }
  if (git(root, ["check-ref-format", `${QUARANTINE_NS}${suffix}`]).status !== 0) {
    refuse(`${name} is not a valid quarantine name`);
  }
  return { requested: form[1], suffix, slug: match[1] };
}

/**
 * The quarantined candidate `name` names, looked up exactly: `refs/ralph/rejected/<s>`,
 * `refs/heads/rejected/<s>`, or the alias `rejected/<s>` for whichever of the two exists (the
 * new namespace when both hold the same commit). Both namespaces are always read: a twin at
 * another commit is a conflicting identity and is refused, whatever form was asked for.
 */
export function resolveCandidate(repo, name) {
  const { requested, suffix, slug } = parseName(String(name ?? ""));
  const current = exactRef(repo, `${QUARANTINE_NS}${suffix}`);
  const legacy = exactRef(repo, `${LEGACY_NS}${suffix}`);
  for (const row of [current, legacy].filter(Boolean)) {
    assertUsable(row);
  }
  if (current && legacy && current.sha !== legacy.sha) {
    refuse(
      `conflicting candidates: ${current.ref} is at ${current.sha} but ${legacy.ref} is at ${legacy.sha}; reconcile them by hand first`,
    );
  }
  const chosen = { quarantine: current, legacy, alias: current ?? legacy }[requested];
  if (!chosen) {
    const wanted = {
      quarantine: `${QUARANTINE_NS}${suffix}`,
      legacy: `${LEGACY_NS}${suffix}`,
      alias: `${QUARANTINE_NS}${suffix} (nor ${LEGACY_NS}${suffix})`,
    }[requested];
    refuse(`no quarantine ref ${wanted} exists`);
  }
  return {
    ref: chosen.ref,
    sha: chosen.sha,
    namespace: chosen === current ? "quarantine" : "legacy",
    suffix,
    slug,
  };
}

// --- The host's rejection record --------------------------------------------------------------

const recordSubject = (slug) => `chore(issues): block issues/${slug}.md after the host review`;
// The whole body, exactly as ralph-accept.mjs writes it; anything else is not the host's record.
const RECORD =
  /^The host's isolated Standards and Spec review of slice\/(\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*) \(([0-9a-f]{12})\) was [^\n]+?, so the slice did not merge\. It is preserved on (\S+)\. Report: \S+$/;

/**
 * The host's own record that `candidate` was rejected by its review, on `base`'s first-parent
 * history. Only the importer writes there, so a candidate a container quarantined itself is never
 * covered. The record must name this exact candidate and the first 12 characters of its commit:
 *   - a candidate in refs/ralph/rejected/ by that full name ("current");
 *   - a legacy branch refs/heads/rejected/<s> as `rejected/<s>` ("legacy");
 *   - D1, the one compatibility exception: a candidate migrated from refs/heads/rejected/<s> to
 *     refs/ralph/rejected/<s> by its old name `rejected/<s>` ("legacy-migrated"). The suffix must
 *     be identical, so it can never vouch for another candidate.
 * A current record never vouches for a branch under refs/heads/.
 */
export function hostRejection(repo, { base, candidate }) {
  const accepted =
    candidate.namespace === "quarantine"
      ? new Map([
          [candidate.ref, "current"],
          [`${ALIAS}${candidate.suffix}`, "legacy-migrated"],
        ])
      : new Map([[`${ALIAS}${candidate.suffix}`, "legacy"]]);
  const subject = recordSubject(candidate.slug);
  const commits = gitOut(repo, [
    "log",
    "--first-parent",
    "--fixed-strings",
    `--grep=${subject}`,
    "--format=%H",
    base,
    "--",
  ])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const [found = "", body = ""] = gitOut(repo, ["log", "-1", "--format=%s%x00%b", commit]).split(
      "\0",
    );
    const match = RECORD.exec(body.replace(/\n+$/, ""));
    if (
      found === subject &&
      match !== null &&
      match[1] === candidate.slug &&
      match[2] === candidate.sha.slice(0, 12) &&
      accepted.has(match[3])
    ) {
      return { commit, form: accepted.get(match[3]), recordedAs: match[3] };
    }
  }
  return refuse(
    `no host-review rejection of ${candidate.ref} at ${candidate.sha.slice(0, 12)} is recorded on ${base}'s first-parent history ("${subject}"); only a candidate the host review rejected can be replayed`,
  );
}

// --- Inspection (read-only) -------------------------------------------------------------------

function kindOf(ref) {
  if (ref.startsWith(QUARANTINE_NS)) {
    return "quarantine";
  }
  if (ref.startsWith(LEGACY_NS)) {
    return "legacy-branch";
  }
  if (ref.startsWith(INCOMING_NS)) {
    return "incoming";
  }
  return PUBLISHED.test(ref) ? "published-copy" : null;
}

const NEVER = {
  incoming: "incoming refs are a run's unvalidated output and are never replayable",
  "published-copy":
    "published copies are never replayable; only the host's own quarantine ref can be",
};

function ticketOf(ref, subject) {
  const fromName = /(?:^|\/)(\d{2})-[a-z0-9-]+-\d{8}-\d{6}$/.exec(ref)?.[1];
  return fromName ?? /\(slice-(\d{2})\)/.exec(subject)?.[1] ?? null;
}

function eligibility(repo, row, kind, base) {
  if (NEVER[kind]) {
    return { eligible: false, why: NEVER[kind], evidence: null };
  }
  try {
    const candidate = resolveCandidate(repo, row.ref);
    const evidence = hostRejection(repo, { base, candidate });
    return {
      eligible: true,
      why: `pin it with --expect ${candidate.sha}`,
      evidence,
    };
  } catch (error) {
    if (!(error instanceof QuarantineRefusal)) {
      throw error;
    }
    return { eligible: false, why: error.message, evidence: null };
  }
}

function describeCommit(repo, row) {
  if (row.symref || row.type !== "commit") {
    return { subject: "", date: "" };
  }
  const [subject = "", date = ""] = gitOut(repo, [
    "log",
    "-1",
    "--no-show-signature",
    "--format=%s%x00%cI",
    row.sha,
  ]).split("\0");
  return { subject, date };
}

/** Every quarantined, legacy, incoming and published rejected ref, each with what it is. */
export function listQuarantine(repo, { base }) {
  return listRefs(repo, [QUARANTINE_NS, LEGACY_NS, INCOMING_NS, "refs/remotes/"])
    .map((row) => ({ row, kind: kindOf(row.ref) }))
    .filter(({ kind }) => kind !== null)
    .map(({ row, kind }) => {
      const { subject, date } = describeCommit(repo, row);
      return {
        ref: row.ref,
        kind,
        sha: row.sha,
        ticket: ticketOf(row.ref, subject),
        subject,
        date,
        ...eligibility(repo, row, kind, base),
      };
    });
}

// The importer's own protected paths, loaded only here: the importer imports this module, and
// inspection must work even where the importer's dependencies are not installed.
async function protectedCheck() {
  try {
    const { PROTECTED_FILES, PROTECTED_DIRS } = await import("./ralph-accept.mjs");
    return (path) => {
      const folded = path.toLowerCase();
      return PROTECTED_FILES.includes(folded) || PROTECTED_DIRS.some((d) => folded.startsWith(d));
    };
  } catch {
    return null;
  }
}

function changedPaths(repo, parent, sha) {
  const fields = gitOut(repo, [
    "diff-tree",
    "-r",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    parent,
    sha,
  ])
    .split("\0")
    .filter(Boolean);
  const list = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, , , status] = fields[i].replace(/^:/, "").split(" ");
    list.push({ path: fields[i + 1], status, oldMode, newMode });
  }
  return list;
}

/** What a human should know about one changed path before reading it. */
function pathWarnings({ path, newMode, status }, isProtected) {
  const shown = printable(path);
  const rule = pathRule(path);
  return [
    shown !== path || path.split("/").some((part) => part.startsWith("-"))
      ? "unprintable or option-like path"
      : null,
    rule,
    isProtected?.(path) ? "protected harness or gate file" : null,
    status !== "D" && newMode === "120000" ? "symlink" : null,
    status !== "D" && newMode === "160000" ? "submodule" : null,
  ]
    .filter(Boolean)
    .map((warning) => `${shown}: ${warning}`);
}

async function warningsFor(repo, { sha, parent, parents, paths }) {
  const warnings = [];
  if (parents.length > 1) {
    warnings.push("a merge commit: only the change against its first parent is shown");
  }
  const isProtected = await protectedCheck();
  if (isProtected === null) {
    warnings.push("the importer's protected-path list could not be loaded; not checked");
  }
  warnings.push(...paths.flatMap((change) => pathWarnings(change, isProtected)));
  const message = gitOut(repo, ["log", "-1", "--no-show-signature", "--format=%B", sha]);
  warnings.push(...contentRules(message).map((rule) => `commit message: ${rule}`));
  warnings.push(...patchWarnings(repo, parent, sha));
  return warnings;
}

// Credential patterns in added lines. No external diff driver, no textconv: the patch is Git's
// own, whatever the repository's config or attributes say.
function patchWarnings(repo, parent, sha) {
  const warnings = [];
  const patch = gitOut(repo, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "-U0",
    parent,
    sha,
    "--",
  ]);
  for (const file of parsePatch(patch)) {
    if (file.binary) {
      warnings.push(`${printable(file.path)}: binary content, not inspected`);
    }
    for (const { line, text } of file.added) {
      for (const rule of contentRules(text)) {
        warnings.push(`${printable(file.path)}:${line}: ${rule}`);
      }
    }
  }
  return warnings;
}

/** One rejected ref in detail, read-only: what it is, the host's evidence, paths and warnings. */
export async function inspectRef(repo, ref, { base }) {
  const kind = kindOf(String(ref));
  if (kind === null) {
    refuse(`${ref} is not a quarantined, incoming or published rejected ref`);
  }
  const row = exactRef(repo, ref) ?? refuse(`${ref} does not exist`);
  assertUsable(row);
  const { subject, date } = describeCommit(repo, row);
  const parents = gitOut(repo, ["rev-list", "--parents", "-n", "1", row.sha]).split(" ").slice(1);
  const parent = parents[0] ?? EMPTY_TREE;
  const paths = changedPaths(repo, parent, row.sha);
  return {
    ref: row.ref,
    kind,
    sha: row.sha,
    ticket: ticketOf(row.ref, subject),
    subject,
    date,
    parents,
    ...eligibility(repo, row, kind, base),
    paths,
    warnings: await warningsFor(repo, { sha: row.sha, parent, parents, paths }),
  };
}

// --- Recovery holds (D2) ----------------------------------------------------------------------

/**
 * Records that a rejection could not be reconciled on the base branch (its quarantine is kept,
 * but the ticket's blocked status is not committed), so the ticket would otherwise look ready.
 * The hold is a ref to a blob with the details: atomic, create-only (the first hold's record is
 * kept), outside refs/heads/ so no branch push sends it, and it survives any cleanup of .ralph/.
 * It is local to this repository: another clone does not see it.
 */
export function placeRecoveryHold(
  repo,
  { slug, commit, preserved, reason, base = null, run = null },
) {
  if (!SLUG.test(slug)) {
    throw new Error(`cannot hold ${JSON.stringify(slug)}: not a ticket slug`);
  }
  const ref = `${RECOVERY_NS}${slug}`;
  const details = {
    ticket: slug,
    commit,
    preserved,
    reason,
    base,
    run,
    at: new Date().toISOString(),
  };
  const object = gitOut(repo, ["hash-object", "-w", "--stdin"], {
    input: `${JSON.stringify(details, null, 2)}\n`,
  });
  const created = git(repo, ["update-ref", ref, object, ZERO]);
  if (created.status === 0) {
    return { ref, object, created: true };
  }
  const existing = exactRef(repo, ref);
  if (existing?.sha) {
    return { ref, object: existing.sha, created: false };
  }
  throw new Error(`could not record the recovery hold ${ref}: ${created.stderr.split("\n")[0]}`);
}

/**
 * Every recovery hold. A hold whose record cannot be read still holds (details: null). Throws
 * when the refs cannot be listed: callers treat that as held, never as clear.
 */
export function recoveryHolds(repo) {
  // A hold whose object is missing makes for-each-ref fail; any warning it prints counts too.
  // Either way the holds are unreadable, which callers treat as held. (Git skips a dangling
  // symbolic ref silently; holds are never symbolic: ADR 0023, Limits.)
  const listed = git(repo, ["for-each-ref", `--format=${FIELDS}`, RECOVERY_NS]);
  if (listed.status !== 0 || listed.stderr.trim() !== "") {
    throw new Error(
      `git for-each-ref ${RECOVERY_NS} failed: ${listed.stderr.trim() || `exit ${listed.status}`}`,
    );
  }
  const rows = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", type = "", symref = ""] = line.split("\0");
      return { ref, sha, type, symref };
    });
  return rows.map((row) => {
    const slug = row.ref.slice(RECOVERY_NS.length);
    let details = null;
    if (row.type === "blob") {
      try {
        const parsed = JSON.parse(gitOut(repo, ["cat-file", "blob", row.sha]));
        details = parsed?.ticket === slug ? parsed : null;
      } catch {
        details = null;
      }
    }
    return { ref: row.ref, slug, object: row.sha, details };
  });
}

/**
 * The one fail-closed reading that every entry point shares: `problem` is null only when the holds
 * could be read and there are none. Holds that cannot be read count as held.
 */
export function recoveryHoldState(repo) {
  try {
    const holds = recoveryHolds(repo);
    return { holds, problem: holds.length > 0 ? holds.map(describeHold).join("; ") : null };
  } catch (error) {
    return {
      holds: [],
      problem: `the recovery holds (${RECOVERY_NS}) cannot be read, so they count as held: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** One line per hold, naming what is preserved and how to release it. */
export function describeHold(hold) {
  const preserved = hold.details?.preserved?.length
    ? hold.details.preserved.join(", ")
    : "unknown (read it with git cat-file -p)";
  return `recovery hold ${hold.ref} (${hold.object}) for ticket ${hold.slug}: ${hold.details?.reason ?? "no readable record"}; work preserved on ${preserved}`;
}

// Release without --rerun needs proof that the base no longer offers the ticket. A base that does
// not resolve, or a ticket file it does not have, proves nothing, so both refuse.
function assertNoLongerOffered(repo, slug, base) {
  const resolved = git(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (resolved.status !== 0) {
    refuse(`the base ${JSON.stringify(base)} does not resolve to a commit (RALPH_BASE_BRANCH?)`);
  }
  const at = resolved.stdout.trim();
  const ticket = git(repo, ["cat-file", "blob", `${at}:issues/${slug}.md`]);
  if (ticket.status !== 0) {
    refuse(
      `issues/${slug}.md is not on ${base}, so its status cannot be checked; pass --rerun to release anyway`,
    );
  }
  const status = /^\*\*Status:\*\* *(.*)$/m.exec(ticket.stdout)?.[1]?.trim();
  if (status === "ready-for-agent") {
    refuse(
      `issues/${slug}.md is still ready-for-agent on ${base}: commit its blocked status first, or pass --rerun if Ralph should run it again`,
    );
  }
}

/**
 * Explicit human reconciliation: removes exactly the named hold, at exactly the object the human
 * read, and only once the base no longer offers the ticket to Ralph (or the human says it should
 * run again). No other ref is touched.
 */
export function releaseRecoveryHold(repo, { slug, expect, base, rerun = false }) {
  if (!SLUG.test(slug)) {
    refuse(`${JSON.stringify(slug)} is not a ticket slug`);
  }
  if (!SHA.test(expect)) {
    refuse("--expect needs the hold's full 40-character object name (holds lists it)");
  }
  const ref = `${RECOVERY_NS}${slug}`;
  const row = exactRef(repo, ref) ?? refuse(`there is no recovery hold ${ref}`);
  if (row.sha !== expect) {
    refuse(`${ref} is at ${row.sha}, not the hold you named (${expect})`);
  }
  if (!rerun) {
    assertNoLongerOffered(repo, slug, base);
  }
  if (git(repo, ["update-ref", "-d", ref, expect]).status !== 0) {
    refuse(`${ref} could not be removed at ${expect}; it moved or is locked`);
  }
  return { ref };
}

// --- Replay scratch refs ----------------------------------------------------------------------

/**
 * Deletes one of the replay's own scratch refs, and only while it is still at `sha`. Anything
 * outside refs/ralph/replay/<replay id>/{main,slice} is refused: the replay may delete nothing else.
 */
export function removeReplayRef(repo, ref, sha) {
  if (!REPLAY_REF.test(ref)) {
    refuse(`${ref} is outside ${REPLAY_NS}<replay id>/; the replay deletes nothing else`);
  }
  return git(repo, ["update-ref", "-d", ref, sha]).status === 0;
}

// --- Command line -----------------------------------------------------------------------------

const env = process.env;
const out = (line) => process.stdout.write(`${printable(line)}\n`);

function printRow(row) {
  const verdict = row.eligible ? "replayable" : "not replayable";
  out(
    `${row.kind.padEnd(14)} ${row.ref} ${row.sha.slice(0, 12)} ticket ${row.ticket ?? "?"} ${verdict} ${row.date} ${row.subject}`,
  );
  out(`${" ".repeat(15)}${row.why}`);
}

const COMMANDS = {
  list({ base }) {
    const rows = listQuarantine(root, { base });
    if (rows.length === 0) {
      out("no quarantined, incoming or published rejected refs");
    }
    for (const row of rows) {
      printRow(row);
    }
    return 0;
  },
  async inspect({ base, positionals }) {
    if (positionals.length !== 1) {
      return null;
    }
    const report = await inspectRef(root, positionals[0], { base });
    printRow(report);
    const { evidence } = report;
    if (evidence) {
      out(
        `host rejection: ${evidence.commit} (${evidence.form}, recorded as ${evidence.recordedAs})`,
      );
    }
    out(`parents: ${report.parents.join(" ") || "none"}`);
    for (const { status, path } of report.paths) {
      out(`  ${status} ${path}`);
    }
    for (const warning of report.warnings) {
      out(`WARNING: ${warning}`);
    }
    return 0;
  },
  holds({ values }) {
    const holds = recoveryHolds(root);
    for (const hold of holds) {
      process.stderr.write(`[ralph-quarantine] ${printable(describeHold(hold))}\n`);
    }
    return values.check && holds.length > 0 ? 1 : 0;
  },
  release({ base, values }) {
    if (!(values.ticket && values.expect)) {
      return null;
    }
    const { ref } = releaseRecoveryHold(root, {
      slug: values.ticket,
      expect: values.expect,
      base,
      rerun: values.rerun,
    });
    out(`released ${ref}; every quarantine and incoming ref is unchanged`);
    return 0;
  },
};

async function main() {
  const [command = "", ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      ticket: { type: "string" },
      expect: { type: "string" },
      rerun: { type: "boolean", default: false },
    },
  });
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  const base = env.RALPH_BASE_BRANCH || "main";
  const status = handler ? await handler({ base, values, positionals }) : null;
  if (status === null) {
    refuse(
      "usage: ralph-quarantine.mjs list | inspect <ref> | holds [--check] | release --ticket <NN-slug> --expect <object> [--rerun]",
    );
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      `[ralph-quarantine] ${error instanceof QuarantineRefusal ? "REFUSED" : "ERROR"}: ${printable(error instanceof Error ? error.message : String(error))}`,
    );
    process.exitCode = 1;
  }
}
