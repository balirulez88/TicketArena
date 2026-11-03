#!/usr/bin/env node
//
// The technical debt register (docs/technical-debt.md): review findings that were deferred
// instead of fixed, kept in the repository so they stay visible to every later ticket, agent and
// reviewer. The register is canonical Markdown with a strict, script-owned section between the
// `ralph-debt:begin` / `ralph-debt:end` markers, so a deterministic parser can read it and humans
// can still edit it (then `format`).
//
// Ralph calls `record` after a review round is APPROVED and before VERIFY; the register change
// therefore lands in the slice's own squashed commit and passes the same gate as the code. The
// recorder only ever adds entries and history; it never resolves anything. Resolving is an agent's
// or human's change, which reviewers judge and `check` holds to evidence.
//
// Usage: node scripts/ralph-debt.mjs check <register> [--root <dir>]
//        node scripts/ralph-debt.mjs format <register>
//        node scripts/ralph-debt.mjs record --register <file> --decision <file> --ticket <file>
//          --run <run-id> --round <n> --date <YYYY-MM-DD> [--base <register on the base branch>]
//
// Exits 0 on success, 1 when the register (or the recording) is invalid.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STATUSES = ["OPEN", "PLANNED", "IN_PROGRESS", "RESOLVED", "ACCEPTED_RISK"];
export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const NONE = "none";
export const DEBT_ID = /^TD-\d{3,}$/;
export const BEGIN = "<!-- ralph-debt:begin -->";
export const END = "<!-- ralph-debt:end -->";

// Field order is the rendering order; every entry has every field ("none" when empty), so a diff
// of the register always shows which field changed.
export const FIELDS = [
  "Status",
  "Severity",
  "Escalation",
  "Source",
  "Evidence",
  "Components",
  "Problem",
  "Impact",
  "Justification",
  "Remediation",
  "Target",
  "Resolution",
  "Verification",
  "Fingerprints",
];
const REQUIRED = ["Source", "Evidence", "Components", "Problem", "Impact", "Remediation"];
// A deferral is a decision, so it must say why (MEDIUM/LOW may wait; they may not wait silently).
const NEEDS_JUSTIFICATION = ["OPEN", "PLANNED", "IN_PROGRESS", "ACCEPTED_RISK"];

export const isSet = (value) => typeof value === "string" && value.trim() !== "" && value !== NONE;
const idNumber = (id) => Number(id.slice(3));

// --- Parsing and rendering ------------------------------------------------------------------

/** Splits the register into the hand-written preamble, the entries and the trailing text. */
export function parseRegister(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const begin = normalized.indexOf(BEGIN);
  const end = normalized.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`register must contain ${BEGIN} followed by ${END}`);
  }
  const preamble = normalized.slice(0, begin);
  const trailer = normalized.slice(end + END.length);
  const body = normalized.slice(begin + BEGIN.length, end);
  const entries = [];
  let current;
  let inHistory = false;
  for (const line of body.split("\n")) {
    const heading = /^### (TD-\d+): (.+)$/.exec(line);
    const field = /^- \*\*([A-Za-z]+):\*\* ?(.*)$/.exec(line);
    const history = /^ {2}- (.+)$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), fields: {}, history: [] };
      entries.push(current);
      inHistory = false;
    } else if (current && field) {
      inHistory = field[1] === "History";
      if (!inHistory) {
        current.fields[field[1]] = field[2].trim();
      }
    } else if (current && inHistory && history) {
      current.history.push(history[1].trim());
    }
  }
  return { preamble, entries, trailer };
}

export function fingerprintsOf(entry) {
  const value = entry.fields.Fingerprints;
  return isSet(value) ? value.split(";").map((part) => part.trim().replace(/^`|`$/g, "")) : [];
}

// Columns padded to their widest cell, the way Biome formats Markdown tables, so `pnpm run format`
// and `format:debt` agree on one canonical text.
function markdownTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(3, ...rows.map((row) => String(row[column]).length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, column) => String(cell).padEnd(widths[column])).join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join(
    "\n",
  );
}

function summaryTable(entries) {
  const rows = STATUSES.map((status) => {
    const inStatus = entries.filter((entry) => entry.fields.Status === status);
    const counts = SEVERITIES.map(
      (severity) => inStatus.filter((entry) => entry.fields.Severity === severity).length,
    );
    return [status, ...counts, inStatus.length];
  });
  return markdownTable([["Status", ...SEVERITIES, "Total"], ...rows]);
}

function renderEntry(entry) {
  const lines = [`### ${entry.id}: ${entry.title}`, ""];
  for (const name of FIELDS) {
    const value = entry.fields[name];
    lines.push(`- **${name}:** ${isSet(value) ? value : NONE}`);
  }
  lines.push(`- **History:**${entry.history.length === 0 ? ` ${NONE}` : ""}`);
  for (const item of entry.history) {
    lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

/** The canonical text: entries sorted by id, the summary recomputed from them. */
export function renderRegister({ preamble, entries, trailer }) {
  const sorted = [...entries].sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const body = [
    "",
    "## Summary",
    "",
    "Generated from the entries below by `node scripts/ralph-debt.mjs format`.",
    "",
    summaryTable(sorted),
    "",
    "## Entries",
    "",
    sorted.length === 0 ? "No entries." : sorted.map(renderEntry).join("\n\n"),
    "",
  ].join("\n");
  return `${preamble}${BEGIN}\n${body}${END}${trailer}`;
}

// --- Validation -------------------------------------------------------------------------------

// Verification must point at something a later reader can re-run: a test file (`path` or
// `path::test name`) that exists in the repository.
function verifiedPaths(value, root) {
  return [...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1].split("::")[0].trim())
    .filter(
      (path) =>
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.split(/[\\/]/).includes("..") &&
        existsSync(join(root, path)),
    );
}

function shapeErrors(entry) {
  const { fields } = entry;
  const errors = Object.keys(fields)
    .filter((name) => !FIELDS.includes(name))
    .map((name) => `unknown field "${name}"`);
  if (!DEBT_ID.test(entry.id)) {
    errors.push("id must look like TD-001");
  }
  if (!STATUSES.includes(fields.Status)) {
    errors.push(`Status must be one of ${STATUSES.join(", ")}`);
  }
  if (!SEVERITIES.includes(fields.Severity)) {
    errors.push(`Severity must be one of ${SEVERITIES.join(", ")}`);
  }
  for (const name of REQUIRED.filter((required) => !isSet(fields[required]))) {
    errors.push(`${name} is required`);
  }
  return errors;
}

function statusErrors({ fields }, root) {
  const errors = [];
  if (NEEDS_JUSTIFICATION.includes(fields.Status) && !isSet(fields.Justification)) {
    errors.push(`a ${fields.Status} entry needs a Justification for the deferral`);
  }
  if (fields.Status === "PLANNED" && !isSet(fields.Target)) {
    errors.push("a PLANNED entry needs a Target (ticket or milestone)");
  }
  // An escalated finding is one whose real risk outgrew its severity: it may not wait unplanned.
  if (isSet(fields.Escalation) && ["OPEN", "ACCEPTED_RISK"].includes(fields.Status)) {
    errors.push("an escalated entry must be PLANNED, IN_PROGRESS or RESOLVED");
  }
  if (fields.Status !== "RESOLVED") {
    return errors;
  }
  if (!isSet(fields.Resolution)) {
    errors.push("a RESOLVED entry needs a Resolution");
  }
  if (!isSet(fields.Verification) || verifiedPaths(fields.Verification, root).length === 0) {
    errors.push("a RESOLVED entry needs Verification naming an existing test in backticks");
  }
  return errors;
}

export function validateRegister(register, { root = "." } = {}) {
  const errors = [];
  const ids = new Set();
  const fingerprints = new Map();
  for (const entry of register.entries) {
    const own = [...shapeErrors(entry), ...statusErrors(entry, root)];
    if (ids.has(entry.id)) {
      own.push("duplicate id");
    }
    ids.add(entry.id);
    for (const print of fingerprintsOf(entry)) {
      if (fingerprints.has(print)) {
        own.push(`fingerprint ${print} is also on ${fingerprints.get(print)}`);
      }
      fingerprints.set(print, entry.id);
    }
    errors.push(...own.map((error) => `${entry.id}: ${error}`));
  }
  return errors;
}

/** Errors for the register text, including drift from the canonical (formatted) form. */
export function checkRegisterText(text, options) {
  let register;
  try {
    register = parseRegister(text);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const errors = validateRegister(register, options);
  if (errors.length === 0 && renderRegister(register) !== text.replace(/\r\n/g, "\n")) {
    errors.push("register is not in canonical form: run `node scripts/ralph-debt.mjs format`");
  }
  return errors;
}

// --- Recording --------------------------------------------------------------------------------

/**
 * Stable identity of a finding across rounds and runs: its file plus its normalized title. Lines
 * shift and wording varies between reviewers, so this only catches literal repeats (the same
 * report processed twice); reviewers name the entry in the finding's `debt` field otherwise.
 */
export function fingerprint(finding) {
  const title = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${finding.file}#${title}`;
}

const severityRank = (severity) => SEVERITIES.indexOf(severity);

function nextId(entries) {
  const highest = entries.reduce((max, entry) => Math.max(max, idNumber(entry.id)), 0);
  return `TD-${String(highest + 1).padStart(3, "0")}`;
}

const location = (finding) => `\`${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}\``;

const sightingOf = (finding) =>
  `${finding.severity} ${finding.kind} at ${location(finding)}, ${finding.axis} axis`;

function newEntry(id, finding, source) {
  return {
    id,
    title: finding.title,
    fields: {
      Status: "OPEN",
      Severity: finding.severity,
      Escalation: NONE,
      Source: source.ticketLabel,
      Evidence: `\`${source.evidence}.${finding.axis}.json\``,
      Components: location(finding),
      Problem: finding.problem,
      Impact: finding.impact,
      Justification: source.justification,
      Remediation: finding.recommendation,
      Target: NONE,
      Resolution: NONE,
      Verification: NONE,
      Fingerprints: NONE,
    },
    history: [],
  };
}

/** A working copy of the register that records each event at most once. */
function ledger(register, source) {
  const entries = register.entries.map((entry) => ({
    ...entry,
    fields: { ...entry.fields },
    history: [...entry.history],
  }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    entries,
    byId,
    // The reference (ticket, round, axis, run), not the date, identifies an event: recording the
    // same round again, on any day, is a no-op.
    note(entry, text, axis) {
      const ref = `${source.ref}${axis ? ` ${axis}` : ""}, run ${source.run}`;
      if (!entry.history.some((item) => item.includes(`(${ref})`))) {
        entry.history.push(`${source.date}: ${text} (${ref})`);
      }
    },
    add(entry) {
      entries.push(entry);
      byId.set(entry.id, entry);
    },
  };
}

// One more sighting of a known problem. Original severity is preserved; the history makes any
// drift visible, so a human can escalate. A resolved problem that is reported again is reopened.
function sightAgain(book, entry, finding, source) {
  const sighting = sightingOf(finding);
  if (entry.fields.Status !== "RESOLVED") {
    const higher = severityRank(finding.severity) < severityRank(entry.fields.Severity);
    const label = higher ? "seen again at a higher severity than recorded" : "seen again";
    book.note(entry, `${label}: ${sighting}`, finding.axis);
    return;
  }
  book.note(
    entry,
    `reopened: reported again as ${sighting}; previous resolution: ${entry.fields.Resolution}`,
    finding.axis,
  );
  Object.assign(entry.fields, {
    Status: "OPEN",
    Resolution: NONE,
    Verification: NONE,
    Justification: source.justification,
  });
}

function addFingerprint(entry, print) {
  const prints = fingerprintsOf(entry);
  if (!prints.includes(print)) {
    entry.fields.Fingerprints = [...prints, print].map((value) => `\`${value}\``).join("; ");
  }
}

// `sameRound` maps file:line to the entry an earlier finding of this round went to.
function recordOne(book, finding, source, sameRound) {
  const print = fingerprint(finding);
  const spot = finding.line > 0 ? `${finding.file}:${finding.line}` : undefined;
  let entry =
    book.byId.get(finding.debt) ??
    book.entries.find((candidate) => fingerprintsOf(candidate).includes(print)) ??
    sameRound.get(spot);
  if (entry) {
    sightAgain(book, entry, finding, source);
  } else {
    entry = newEntry(nextId(book.entries), finding, source);
    book.add(entry);
    book.note(entry, `recorded: ${sightingOf(finding)}`, finding.axis);
  }
  addFingerprint(entry, print);
  if (spot !== undefined) {
    sameRound.set(spot, entry);
  }
}

/**
 * Merges the deferred findings of an approved review round into the register.
 *
 * Deduplication, in order: the finding's `debt` id; a fingerprint already on an entry; another
 * finding of the same round at the same file and line (the two axes describing one problem).
 * Every update is keyed by its source reference, so recording the same round again is a no-op.
 */
export function recordFindings(register, { findings, blocking, source, base }) {
  const book = ledger(register, source);
  // The register is append-only for the harness and for agents: losing an entry hides debt.
  const errors = (base?.entries ?? [])
    .filter((old) => !book.byId.has(old.id))
    .map((old) => `${old.id} exists on the base branch but was removed from the register`);

  const sameRound = new Map();
  for (const finding of findings) {
    if (blocking.includes(finding.severity)) {
      // An approved round has no blocking findings; recording one would hide a merge blocker.
      errors.push(`refusing to record blocking ${finding.severity} finding "${finding.title}"`);
    } else if (isSet(finding.debt) && !book.byId.has(finding.debt)) {
      errors.push(`finding "${finding.title}" names unknown debt ${finding.debt}`);
    } else {
      recordOne(book, finding, source, sameRound);
    }
  }

  // A resolution that reaches the base branch carries the harness's attestation: the gate and an
  // approved independent review judged the change that resolved it.
  const before = new Map((base?.entries ?? []).map((entry) => [entry.id, entry.fields.Status]));
  for (const entry of base ? book.entries : []) {
    if (entry.fields.Status === "RESOLVED" && before.get(entry.id) !== "RESOLVED") {
      book.note(entry, "resolution verified: quality gate green and independent review approved");
    }
  }

  return { register: { ...register, entries: book.entries }, errors };
}

// --- CLI --------------------------------------------------------------------------------------

function ticketSource(ticketPath, run, round) {
  const slug = basename(ticketPath, ".md");
  const number = slug.slice(0, 2);
  return {
    ticketLabel: `ticket ${number} (\`${slug}\`)`,
    ref: `ticket ${number} review-${round}`,
    run,
    evidence: `.ralph/logs/${run}/${slug}.review-${round}`,
  };
}

function record(values) {
  for (const name of ["register", "decision", "ticket", "run", "round", "date"]) {
    if (!values[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  const text = readFileSync(values.register, "utf8");
  const register = parseRegister(text);
  const decision = JSON.parse(readFileSync(values.decision, "utf8"));
  if (decision.verdict !== "approved") {
    throw new Error(`only an approved review is recorded (verdict: ${decision.verdict})`);
  }
  const base = values.base ? parseRegister(readFileSync(values.base, "utf8")) : undefined;
  const blocking = decision.blocking ?? ["CRITICAL", "HIGH"];
  const source = {
    ...ticketSource(values.ticket, values.run, values.round),
    date: values.date,
    justification:
      `Non-blocking under the merge policy (blocking: ${blocking.join(", ")}); ` +
      "deferred when the ticket merged. Escalate if its real impact grows.",
  };
  const result = recordFindings(register, {
    findings: decision.findings ?? [],
    blocking,
    source,
    base,
  });
  const errors = [...result.errors, ...validateRegister(result.register)];
  if (errors.length > 0) {
    throw new Error(`cannot record review findings:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  writeFileSync(values.register, renderRegister(result.register));
  const added = result.register.entries.length - register.entries.length;
  console.error(`technical debt: ${added} new entr${added === 1 ? "y" : "ies"} recorded`);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      register: { type: "string" },
      decision: { type: "string" },
      ticket: { type: "string" },
      run: { type: "string" },
      round: { type: "string" },
      date: { type: "string" },
      base: { type: "string" },
      root: { type: "string", default: "." },
    },
  });
  const [command, path] = positionals;
  if (command === "check" || command === "format") {
    if (!path) {
      throw new Error(`${command} needs the register path`);
    }
    const text = readFileSync(path, "utf8");
    if (command === "format") {
      writeFileSync(path, renderRegister(parseRegister(text)));
    }
    const errors = checkRegisterText(readFileSync(path, "utf8"), { root: values.root });
    if (errors.length > 0) {
      throw new Error(`${path} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    }
    return;
  }
  if (command === "record") {
    record(values);
    return;
  }
  throw new Error("usage: ralph-debt.mjs check|format <register> | record --register ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`technical debt: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
