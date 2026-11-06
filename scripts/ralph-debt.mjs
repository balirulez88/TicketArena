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
// recorder only ever adds entries and history; it never resolves or triages anything.
//
// The debt gate (ADR 0016) lives here too, as pure functions the trusted host calls on the base
// branch's register: `debtGate` decides, per ticket, whether unresolved debt lets it start;
// `sliceErrors` decides what a slice may change in the register (it may resolve entries, never
// triage them) and that a ticket resolves the entries it owns; `auditErrors` holds a maintainer's
// triage changes to a history line each. Risk class (`Risk`) and blocking (`Blocks`) are separate
// fields: a class never blocks anything by itself.
//
// Usage: node scripts/ralph-debt.mjs check <register> [--root <dir>]
//        node scripts/ralph-debt.mjs format <register>
//        node scripts/ralph-debt.mjs gate <register> [--root <dir>]
//        node scripts/ralph-debt.mjs slice <register> --base <register on the base> --ticket NN
//          [--root <dir>]
//        node scripts/ralph-debt.mjs audit <register> --base <register before the change>
//        node scripts/ralph-debt.mjs report <register> [--root <dir>]
//        node scripts/ralph-debt.mjs record --register <file> --decision <file> --ticket <file>
//          --run <run-id> --round <n> --date <YYYY-MM-DD> [--base <register on the base branch>]
//
// `--root` is the repository whose issues/ (and issues/done/) hold the tickets; tests and Verification
// paths resolve against it too. Exits 0 on success, 1 when the register (or the request) is invalid.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STATUSES = ["OPEN", "PLANNED", "IN_PROGRESS", "RESOLVED", "ACCEPTED_RISK"];
export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
// What could go wrong if the finding stays: the class, not whether anything waits for it.
export const RISKS = [
  "CORRECTNESS",
  "CONCURRENCY",
  "SECURITY",
  "VERIFICATION",
  "OPERABILITY",
  "MAINTAINABILITY",
];
export const UNTRIAGED = "UNTRIAGED";
export const PENDING = "pending";
export const NONE = "none";
export const DEBT_ID = /^TD-\d{3,}$/;
export const BEGIN = "<!-- ralph-debt:begin -->";
export const END = "<!-- ralph-debt:end -->";

// Field order is the rendering order; every entry has every field ("none" when empty), so a diff
// of the register always shows which field changed.
export const FIELDS = [
  "Status",
  "Severity",
  "Risk",
  "Triage",
  "Escalation",
  "Source",
  "Evidence",
  "Components",
  "Problem",
  "Impact",
  "Justification",
  "Remediation",
  "Target",
  "Blocks",
  "Acceptance",
  "Resolution",
  "Verification",
  "Fingerprints",
];
// The debt gate's fields start untriaged: a register written before them gains these on `format`,
// and no automated step can make a finding look triaged.
const DEFAULTS = { Risk: UNTRIAGED, Triage: PENDING };
// Decisions only a human makes about an existing entry. A slice may not make them (sliceErrors);
// a maintainer who does records why in the entry's history (auditErrors).
export const GOVERNED = [
  "Status",
  "Severity",
  "Risk",
  "Triage",
  "Escalation",
  "Target",
  "Blocks",
  "Acceptance",
];
const REQUIRED = ["Source", "Evidence", "Components", "Problem", "Impact", "Remediation"];
// A deferral is a decision, so it must say why (MEDIUM/LOW may wait; they may not wait silently).
const NEEDS_JUSTIFICATION = ["OPEN", "PLANNED", "IN_PROGRESS", "ACCEPTED_RISK"];
const UNRESOLVED = ["OPEN", "PLANNED", "IN_PROGRESS"];
// Severities that must be triaged and owned before any further autonomous ticket starts.
const MUST_TRIAGE = ["CRITICAL", "HIGH", "MEDIUM"];
// An accepted risk is a human decision a later reader can re-examine.
const ACCEPTANCE_PARTS = ["Residual risk:", "Review when:", "Decided by:"];
// Evidence must be executable: a file the gate runs as tests.
const TEST_FILE = /\.test\.(?:[cm]?[jt]sx?|sh)$/;
const TICKET = /^\d{2}$/;

export const isSet = (value) => typeof value === "string" && value.trim() !== "" && value !== NONE;
const idNumber = (id) => Number(id.slice(3));

/** A field's value, with the debt gate's defaults for registers and entries that predate it. */
export const fieldOf = (entry, name) => entry.fields[name] ?? DEFAULTS[name] ?? NONE;
export const isUnresolved = (entry) => UNRESOLVED.includes(fieldOf(entry, "Status"));
export const isTriaged = (entry) => fieldOf(entry, "Triage") !== PENDING;
/** The ticket that owns the fix: the `ticket NN` a Target starts with. */
export const ownerOf = (entry) => /^ticket (\d{2})\b/.exec(fieldOf(entry, "Target"))?.[1] ?? null;
/** The ticket whose review found it, when the Source is one. */
export const sourceTicketOf = (entry) =>
  /^ticket (\d{2})\b/.exec(fieldOf(entry, "Source"))?.[1] ?? null;
export function blocksOf(entry) {
  const value = fieldOf(entry, "Blocks");
  return isSet(value) ? value.split(",").map((part) => part.trim()) : [];
}

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
    const inStatus = entries.filter((entry) => fieldOf(entry, "Status") === status);
    const counts = SEVERITIES.map(
      (severity) => inStatus.filter((entry) => fieldOf(entry, "Severity") === severity).length,
    );
    return [status, ...counts, inStatus.length];
  });
  return markdownTable([["Status", ...SEVERITIES, "Total"], ...rows]);
}

function riskTable(entries) {
  const rows = [...RISKS, UNTRIAGED].map((risk) => {
    const inRisk = entries.filter((entry) => fieldOf(entry, "Risk") === risk);
    const counts = STATUSES.map(
      (status) => inRisk.filter((entry) => fieldOf(entry, "Status") === status).length,
    );
    return [risk, ...counts, inRisk.length];
  });
  return markdownTable([["Risk", ...STATUSES, "Total"], ...rows]);
}

function renderEntry(entry) {
  const lines = [`### ${entry.id}: ${entry.title}`, ""];
  for (const name of FIELDS) {
    const value = fieldOf(entry, name);
    lines.push(`- **${name}:** ${isSet(value) ? value : NONE}`);
  }
  lines.push(`- **History:**${entry.history.length === 0 ? ` ${NONE}` : ""}`);
  for (const item of entry.history) {
    lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

/** The canonical text: entries sorted by id, the summaries recomputed from them. */
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
    riskTable(sorted),
    "",
    "## Entries",
    "",
    sorted.length === 0 ? "No entries." : sorted.map(renderEntry).join("\n\n"),
    "",
  ].join("\n");
  return `${preamble}${BEGIN}\n${body}${END}${trailer}`;
}

// --- Tickets (contract: issues/README.md) -----------------------------------------------------

/** The parts of a ticket the debt gate needs: its number, status and blockers. */
export function parseTicket(name, text) {
  const field = (label) =>
    new RegExp(`^\\*\\*${label}:\\*\\* *(.*)$`, "m").exec(text)?.[1]?.replace(/\r$/, "").trim() ??
    "";
  const blocked = field("Blocked by");
  // Parenthesised titles may contain digits; only the bare two-digit numbers are references.
  const blockedBy = blocked.startsWith("None")
    ? []
    : (blocked.replace(/\([^)]*\)/g, "").match(/\b\d{2}\b/g) ?? []);
  return { number: name.slice(0, 2), status: field("Status"), blockedBy };
}

/** Every ticket in `<root>/issues` and `<root>/issues/done`, by number. */
export function loadTickets(root) {
  const tickets = new Map();
  for (const dir of [join(root, "issues"), join(root, "issues", "done")]) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir).filter((file) => /^\d{2}-.*\.md$/.test(file))) {
      tickets.set(name.slice(0, 2), parseTicket(name, readFileSync(join(dir, name), "utf8")));
    }
  }
  return tickets;
}

/** Every ticket `number` builds on, directly or through its blockers' blockers. */
function ancestorsOf(tickets, number) {
  const seen = new Set();
  const queue = [...(tickets.get(number)?.blockedBy ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next !== undefined && !seen.has(next)) {
      seen.add(next);
      queue.push(...(tickets.get(next)?.blockedBy ?? []));
    }
  }
  return seen;
}

// --- Validation -------------------------------------------------------------------------------

// Verification must point at something a later reader can re-run: test files (`path` or
// `path::test name`) that exist in the repository and that the gate executes. Code spans that
// name no file (a script name, a scenario) are prose; every one that names a file is evidence.
function verificationErrors(value, exists) {
  const paths = [...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1].split("::")[0].trim())
    .filter((path) => path.includes("/") || TEST_FILE.test(path));
  if (paths.length === 0) {
    return ["a RESOLVED entry needs Verification naming an existing test in backticks"];
  }
  const errors = [];
  for (const path of paths) {
    const inside = path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
    if (!(inside && exists(path))) {
      errors.push(`Verification names ${path}, which is not an existing test in the repository`);
    } else if (!TEST_FILE.test(path)) {
      errors.push(`Verification names ${path}, which is not a test file the gate runs`);
    }
  }
  return errors;
}

function shapeErrors(entry) {
  const errors = Object.keys(entry.fields)
    .filter((name) => !FIELDS.includes(name))
    .map((name) => `unknown field "${name}"`);
  const value = (name) => fieldOf(entry, name);
  if (!DEBT_ID.test(entry.id)) {
    errors.push("id must look like TD-001");
  }
  if (!STATUSES.includes(value("Status"))) {
    errors.push(`Status must be one of ${STATUSES.join(", ")}`);
  }
  if (!SEVERITIES.includes(value("Severity"))) {
    errors.push(`Severity must be one of ${SEVERITIES.join(", ")}`);
  }
  if (![...RISKS, UNTRIAGED].includes(value("Risk"))) {
    errors.push(`Risk must be one of ${[...RISKS, UNTRIAGED].join(", ")}`);
  }
  if (!(value("Triage") === PENDING || /^\d{4}-\d{2}-\d{2}: \S/.test(value("Triage")))) {
    errors.push(`Triage must be "${PENDING}" or "YYYY-MM-DD: <who decided, and where>"`);
  }
  if (isSet(value("Target")) && ownerOf(entry) === null) {
    errors.push('Target must be "none" or start with "ticket NN"');
  }
  if (isSet(value("Blocks")) && !blocksOf(entry).every((number) => TICKET.test(number))) {
    errors.push('Blocks must be "none" or two-digit ticket numbers, comma separated');
  }
  for (const name of REQUIRED.filter((required) => !isSet(value(required)))) {
    errors.push(`${name} is required`);
  }
  return errors;
}

function blockingErrors(entry) {
  const errors = [];
  const blocks = blocksOf(entry);
  if (blocks.length > 0 && ownerOf(entry) === null) {
    errors.push("an entry that Blocks tickets needs a Target ticket that owns the fix");
  }
  if (blocks.includes(ownerOf(entry) ?? "")) {
    errors.push("an entry cannot block the ticket that owns its fix");
  }
  if (isUnresolved(entry) && blocks.length > 0 && !isTriaged(entry)) {
    errors.push("only a triaged entry may block tickets");
  }
  return errors;
}

function acceptanceErrors(entry) {
  const value = (name) => fieldOf(entry, name);
  const errors = [];
  if (value("Status") === "ACCEPTED_RISK") {
    if (!isTriaged(entry)) {
      errors.push("an ACCEPTED_RISK entry must be triaged");
    }
    if (blocksOf(entry).length > 0) {
      errors.push("an ACCEPTED_RISK entry cannot block tickets");
    }
    const acceptance = value("Acceptance");
    for (const part of ACCEPTANCE_PARTS.filter((wanted) => !acceptance.includes(wanted))) {
      errors.push(`an ACCEPTED_RISK entry needs "${part}" in Acceptance`);
    }
  } else if (isSet(value("Acceptance")) && value("Status") !== "RESOLVED") {
    errors.push("Acceptance belongs to an ACCEPTED_RISK entry");
  }
  return errors;
}

function triageErrors(entry) {
  const value = (name) => fieldOf(entry, name);
  const errors = [];
  if (isTriaged(entry) && value("Risk") === UNTRIAGED) {
    errors.push("a triaged entry needs a Risk class");
  }
  // A MEDIUM or worse finding may wait, but never unowned once a human has looked at it.
  if (
    isUnresolved(entry) &&
    isTriaged(entry) &&
    MUST_TRIAGE.includes(value("Severity")) &&
    ownerOf(entry) === null
  ) {
    errors.push(`a triaged ${value("Severity")} entry needs a Target ticket that owns the fix`);
  }
  return [...errors, ...blockingErrors(entry), ...acceptanceErrors(entry)];
}

function statusErrors(entry, exists) {
  const value = (name) => fieldOf(entry, name);
  const status = value("Status");
  const errors = [];
  if (NEEDS_JUSTIFICATION.includes(status) && !isSet(value("Justification"))) {
    errors.push(`a ${status} entry needs a Justification for the deferral`);
  }
  if (status === "PLANNED" && !isSet(value("Target"))) {
    errors.push("a PLANNED entry needs a Target (ticket or milestone)");
  }
  // An escalated finding is one whose real risk outgrew its severity: it may not wait unplanned.
  if (isSet(value("Escalation")) && ["OPEN", "ACCEPTED_RISK"].includes(status)) {
    errors.push("an escalated entry must be PLANNED, IN_PROGRESS or RESOLVED");
  }
  if (status !== "RESOLVED") {
    return errors;
  }
  if (!isSet(value("Resolution"))) {
    errors.push("a RESOLVED entry needs a Resolution");
  }
  errors.push(...verificationErrors(value("Verification"), exists));
  return errors;
}

// Unresolved debt must point at tickets that can still act on it. A Target or Blocks naming a
// ticket that is done was bypassed or forgotten: someone reconciles it (resolve or re-plan).
function referenceErrors(entry, tickets) {
  if (!isUnresolved(entry)) {
    return [];
  }
  const errors = [];
  const owner = ownerOf(entry);
  if (owner !== null && !tickets.has(owner)) {
    errors.push(`Target names ticket ${owner}, which does not exist`);
  } else if (owner !== null && tickets.get(owner)?.status === "done") {
    errors.push(
      `Target ticket ${owner} is done but the entry is still ${fieldOf(entry, "Status")}: reconcile it`,
    );
  }
  for (const number of blocksOf(entry)) {
    if (!tickets.has(number)) {
      errors.push(`Blocks names ticket ${number}, which does not exist`);
    } else if (tickets.get(number)?.status === "done") {
      errors.push(`Blocks names ticket ${number}, which is done: reconcile it`);
    }
  }
  return errors;
}

// Blockers plus debt (a ticket waits on the owner of every entry that blocks it) must form no
// cycle among unfinished tickets, or nothing on the cycle could ever start.
function cycleErrors(register, tickets) {
  const edges = new Map();
  const add = (from, to) => {
    if (tickets.get(from)?.status !== "done" && tickets.get(to)?.status !== "done") {
      edges.set(from, [...(edges.get(from) ?? []), to]);
    }
  };
  for (const ticket of tickets.values()) {
    for (const blocker of ticket.blockedBy) {
      add(ticket.number, blocker);
    }
  }
  for (const entry of register.entries.filter(isUnresolved)) {
    for (const number of blocksOf(entry)) {
      add(number, ownerOf(entry) ?? "");
    }
  }
  const state = new Map();
  const visit = (node, path) => {
    if (state.get(node) === "done") {
      return null;
    }
    if (state.get(node) === "active") {
      return [...path.slice(path.indexOf(node)), node];
    }
    state.set(node, "active");
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle) {
        return cycle;
      }
    }
    state.set(node, "done");
    return null;
  };
  for (const node of [...edges.keys()].sort()) {
    const cycle = visit(node, []);
    if (cycle) {
      return [`ticket dependencies form a cycle: ${cycle.join(" -> ")}`];
    }
  }
  return [];
}

/**
 * `root` resolves Verification paths on the file system (the CLI and the in-sandbox gate). The
 * host's importer passes `exists` instead, to judge evidence in the candidate commit's own tree;
 * when `exists` is given, `root` is not used. With `tickets`, references to tickets are checked
 * too (they exist, unresolved debt names no finished ticket, no dependency cycle).
 */
export function validateRegister(
  register,
  { root = ".", exists = (path) => existsSync(join(root, path)), tickets } = {},
) {
  const errors = [];
  const ids = new Set();
  const fingerprints = new Map();
  for (const entry of register.entries) {
    const own = [
      ...shapeErrors(entry),
      ...statusErrors(entry, exists),
      ...triageErrors(entry),
      ...(tickets ? referenceErrors(entry, tickets) : []),
    ];
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
  if (tickets) {
    errors.push(...cycleErrors(register, tickets));
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

// --- The debt gate ----------------------------------------------------------------------------

/**
 * Whether unresolved debt lets each unfinished ticket start, decided from the register and the
 * tickets alone, so every caller (ralph-loop.sh's ticket selection, the batch, the host importer)
 * reaches the same verdict. Per ticket: `clear`; `waiting` (a triaged entry Blocks it until the
 * entry's owner resolves it, as a blocker would); or `needs-triage`, which stops autonomous work:
 *
 *   - an unresolved MEDIUM or worse finding that is untriaged or has no owning ticket stops every
 *     ticket (the severity-based triage requirement);
 *   - an untriaged finding stops each ticket that builds on the ticket whose review found it (its
 *     transitive blockers), or every ticket when its source is not a ticket: until a human
 *     triages it, nothing can show that the ticket does not rely on the unresolved behaviour.
 *
 * A triaged LOW finding that Blocks nothing is deferred and holds nothing up, whatever its class.
 */
export function debtGate(register, tickets) {
  const open = register.entries.filter(isUnresolved);
  const mustTriage = (entry) => MUST_TRIAGE.includes(fieldOf(entry, "Severity"));
  // MEDIUM or worse, untriaged or unowned: nobody knows yet what it affects, so it holds all work.
  const everywhere = open
    .filter((entry) => mustTriage(entry) && (!isTriaged(entry) || ownerOf(entry) === null))
    .map(
      (entry) =>
        `${entry.id} (${fieldOf(entry, "Severity")}) is ${isTriaged(entry) ? "unowned (no Target ticket)" : "untriaged"}`,
    );
  const untriagedLow = open.filter((entry) => !(isTriaged(entry) || mustTriage(entry)));
  const blocking = open.filter(isTriaged);
  const verdicts = new Map();
  for (const ticket of [...tickets.values()].filter((t) => t.status !== "done")) {
    const triage = [...everywhere, ...lowTriageReasons(untriagedLow, tickets, ticket.number)];
    const waits = blocking
      .filter((entry) => blocksOf(entry).includes(ticket.number))
      .map(
        (entry) =>
          `${entry.id} (${fieldOf(entry, "Risk")}) until ticket ${ownerOf(entry)} resolves it`,
      );
    const state = triage.length > 0 ? "needs-triage" : waits.length > 0 ? "waiting" : "clear";
    verdicts.set(ticket.number, { state, reasons: triage.length > 0 ? triage : waits });
  }
  return verdicts;
}

// An untriaged LOW finding holds the tickets that build on the work it was found in (and the
// ticket that owns it): until a human judges it, it is never assumed safe for them. A finding no
// ticket's review produced could concern anything, so it holds every ticket.
function lowTriageReasons(entries, tickets, number) {
  const builtOn = ancestorsOf(tickets, number);
  const reasons = [];
  for (const entry of entries) {
    const source = sourceTicketOf(entry);
    if (source === null) {
      reasons.push(`${entry.id} is untriaged and was not found by a ticket's review`);
    } else if (builtOn.has(source)) {
      reasons.push(`${entry.id} is untriaged and ticket ${number} builds on ticket ${source}`);
    } else if (ownerOf(entry) === number) {
      reasons.push(`${entry.id} is untriaged and owned by ticket ${number}`);
    }
  }
  return reasons;
}

// --- What a slice may change ----------------------------------------------------------------

const RECORD = ["Severity", "Risk", "Escalation", "Source", "Evidence", "Components"];
const DESCRIPTION = ["Problem", "Impact", "Remediation"];
const startsWith = (prefix, list) => prefix.every((item, index) => list[index] === item);

function identityErrors(before, after) {
  const changed = (name) => fieldOf(before, name) !== fieldOf(after, name);
  const errors = [];
  if (before.title !== after.title) {
    errors.push("its title changed");
  }
  if (!startsWith(before.history, after.history)) {
    errors.push("history lines were changed or removed");
  }
  if (!startsWith(fingerprintsOf(before), fingerprintsOf(after))) {
    errors.push("fingerprints were changed or removed");
  }
  for (const name of [...RECORD, ...DESCRIPTION].filter(changed)) {
    errors.push(`${name} changed; only a human-reviewed commit may change it`);
  }
  return errors;
}

function changedEntryErrors(before, after) {
  const was = fieldOf(before, "Status");
  const now = fieldOf(after, "Status");
  const changed = (name) => fieldOf(before, name) !== fieldOf(after, name);
  // The two transitions the work itself produces: the agent resolves an entry it fixed and tested;
  // the recorder reopens one a review reports again, which also discards its earlier triage.
  const resolving = was !== "RESOLVED" && now === "RESOLVED";
  const reopened = ["RESOLVED", "ACCEPTED_RISK"].includes(was) && now === "OPEN";
  const errors = identityErrors(before, after);
  if (changed("Status") && !(resolving || reopened)) {
    errors.push(`Status ${was} -> ${now} is a triage decision; a slice may only resolve an entry`);
  }
  if (changed("Triage") && fieldOf(after, "Triage") !== PENDING) {
    errors.push("Triage changed; only a human triages an entry");
  }
  if (reopened && isTriaged(after)) {
    errors.push("a reopened entry must be untriaged");
  }
  for (const name of ["Target", "Blocks", "Acceptance"].filter(changed)) {
    if (!(reopened && fieldOf(after, name) === NONE)) {
      errors.push(`${name} changed; only a human-reviewed commit may change it`);
    }
  }
  if (changed("Justification") && !reopened) {
    errors.push("Justification changed; only a human-reviewed commit may change it");
  }
  return [...errors, ...evidenceErrors(before, after, { resolving, reopened })];
}

function evidenceErrors(before, after, { resolving, reopened }) {
  const changed = (name) => fieldOf(before, name) !== fieldOf(after, name);
  const evidenceChanged = changed("Resolution") || changed("Verification");
  const evidenceCleared =
    fieldOf(after, "Resolution") === NONE && fieldOf(after, "Verification") === NONE;
  return evidenceChanged && !resolving && !(reopened && evidenceCleared)
    ? ["Resolution or Verification changed without resolving the entry"]
    : [];
}

function newEntryErrors(entry) {
  const wanted = {
    Status: "OPEN",
    Triage: PENDING,
    Escalation: NONE,
    Target: NONE,
    Blocks: NONE,
    Acceptance: NONE,
    Resolution: NONE,
    Verification: NONE,
  };
  return Object.entries(wanted)
    .filter(([name, value]) => fieldOf(entry, name) !== value)
    .map(([name, value]) => `a new entry must have ${name} ${value}`);
}

/**
 * What is wrong with the register a slice of ticket `ticket` produced from the base's. A slice
 * resolves entries (with evidence, judged by validateRegister) and the recorder adds or reopens
 * them; every triage decision (class, owner, what it blocks, acceptance, severity) stays as the
 * base has it. Every entry the ticket owns on the base must be RESOLVED by the slice itself.
 */
export function sliceErrors(base, next, { ticket }) {
  const errors = [];
  if (base.preamble !== next.preamble || base.trailer !== next.trailer) {
    errors.push("the register's rules outside the generated section changed");
  }
  const after = new Map(next.entries.map((entry) => [entry.id, entry]));
  const highest = base.entries.reduce((max, entry) => Math.max(max, idNumber(entry.id)), 0);
  for (const before of base.entries) {
    const entry = after.get(before.id);
    if (entry === undefined) {
      errors.push(`${before.id} exists on the base branch but was removed from the register`);
      continue;
    }
    errors.push(...changedEntryErrors(before, entry).map((error) => `${before.id}: ${error}`));
    if (
      isUnresolved(before) &&
      ownerOf(before) === ticket &&
      fieldOf(entry, "Status") !== "RESOLVED"
    ) {
      errors.push(
        `${before.id} is owned by ticket ${ticket} (Target) and must be RESOLVED, with a Verification test, before the ticket merges`,
      );
    }
  }
  const known = new Set(base.entries.map((entry) => entry.id));
  for (const entry of next.entries.filter((candidate) => !known.has(candidate.id))) {
    const own = newEntryErrors(entry);
    if (idNumber(entry.id) <= highest) {
      own.push("a new entry must take an id above every existing one");
    }
    errors.push(...own.map((error) => `${entry.id}: ${error}`));
  }
  return errors;
}

/**
 * What is wrong with a maintainer's change to the register: entries and history lines only grow,
 * and every triage decision that changes on an existing entry comes with a new history line that
 * says why. A field the base did not have yet (an older register format) is not a change.
 */
export function auditErrors(base, next) {
  const errors = [];
  const after = new Map(next.entries.map((entry) => [entry.id, entry]));
  for (const before of base.entries) {
    const entry = after.get(before.id);
    if (entry === undefined) {
      errors.push(`${before.id} was removed from the register`);
      continue;
    }
    if (!startsWith(before.history, entry.history)) {
      errors.push(`${before.id}: history lines were changed or removed`);
    }
    const changed = GOVERNED.filter(
      (name) => name in before.fields && fieldOf(before, name) !== fieldOf(entry, name),
    );
    if (changed.length > 0 && entry.history.length <= before.history.length) {
      errors.push(
        `${before.id}: ${changed.join(", ")} changed without a new history line saying who decided and why`,
      );
    }
  }
  const known = new Set(base.entries.map((entry) => entry.id));
  for (const entry of next.entries.filter((candidate) => !known.has(candidate.id))) {
    if (entry.history.length === 0) {
      errors.push(`${entry.id}: a new entry needs a history line saying where it comes from`);
    }
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

// A review's finding kind suggests a class; only `security` is unambiguous enough to set it. A
// suggestion never triages: the entry stays `pending` until a human decides class and blocking.
const SUGGESTED_RISK = {
  defect: "CORRECTNESS",
  regression_risk: "CORRECTNESS",
  security: "SECURITY",
  missing_test: "VERIFICATION",
  unverified_assumption: "VERIFICATION",
  spec_gap: "VERIFICATION",
  architecture: "MAINTAINABILITY",
  maintainability: "MAINTAINABILITY",
  scope_creep: "MAINTAINABILITY",
};
const AUTOMATIC_RISK = new Set(["security"]);

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
      Risk: AUTOMATIC_RISK.has(finding.kind) ? SUGGESTED_RISK[finding.kind] : UNTRIAGED,
      Triage: PENDING,
      Escalation: NONE,
      Source: source.ticketLabel,
      Evidence: `\`${source.evidence}.${finding.axis}.json\``,
      Components: location(finding),
      Problem: finding.problem,
      Impact: finding.impact,
      Justification: source.justification,
      Remediation: finding.recommendation,
      Target: NONE,
      Blocks: NONE,
      Acceptance: NONE,
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

// The earlier decision about the entry no longer holds: it goes back to a human, unowned.
function reopen(entry, source) {
  Object.assign(entry.fields, {
    Status: "OPEN",
    Triage: PENDING,
    Target: NONE,
    Blocks: NONE,
    Acceptance: NONE,
    Resolution: NONE,
    Verification: NONE,
    Justification: source.justification,
  });
}

// One more sighting of a known problem. Original severity is preserved; the history makes any
// drift visible. A sighting at a higher severity sends the entry back to triage (an accepted risk
// is reopened, since its acceptance assumed the lower severity). A resolved problem that is
// reported again is reopened.
function sightAgain(book, entry, finding, source) {
  const sighting = sightingOf(finding);
  const status = fieldOf(entry, "Status");
  if (status !== "RESOLVED") {
    const higher = severityRank(finding.severity) < severityRank(fieldOf(entry, "Severity"));
    if (!higher) {
      book.note(entry, `seen again: ${sighting}`, finding.axis);
      return;
    }
    book.note(
      entry,
      `seen again at a higher severity than recorded: ${sighting}; back to triage`,
      finding.axis,
    );
    if (status === "ACCEPTED_RISK") {
      reopen(entry, source);
    } else {
      entry.fields.Triage = PENDING;
    }
    return;
  }
  book.note(
    entry,
    `reopened: reported again as ${sighting}; previous resolution: ${fieldOf(entry, "Resolution")}`,
    finding.axis,
  );
  reopen(entry, source);
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
    const suggested = SUGGESTED_RISK[finding.kind];
    book.note(
      entry,
      `recorded: ${sightingOf(finding)}${suggested ? `; suggested risk ${suggested}, awaiting triage` : ""}`,
      finding.axis,
    );
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
  const before = new Map(
    (base?.entries ?? []).map((entry) => [entry.id, fieldOf(entry, "Status")]),
  );
  for (const entry of base ? book.entries : []) {
    if (fieldOf(entry, "Status") === "RESOLVED" && before.get(entry.id) !== "RESOLVED") {
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

const listed = (errors) => errors.map((error) => `  - ${error}`).join("\n");

/** The register, validated against the repository's tickets; refuses an invalid one. */
function validRegister(path, root) {
  const text = readFileSync(path, "utf8");
  const tickets = loadTickets(root);
  const errors = checkRegisterText(text, { root, tickets });
  if (errors.length > 0) {
    throw new Error(`${path} is invalid:\n${listed(errors)}`);
  }
  return { register: parseRegister(text), tickets };
}

function gateLines(register, tickets) {
  return [...debtGate(register, tickets)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([number, { state, reasons }]) => `${number}\t${state}\t${reasons.join("; ")}`);
}

function report(register, tickets) {
  const count = (filter) => register.entries.filter(filter).length;
  const lines = [
    "Debt by severity and status:",
    summaryTable(register.entries),
    "",
    "Debt by risk class and status:",
    riskTable(register.entries),
    "",
    `Unresolved: ${count(isUnresolved)}, of which untriaged: ${count((e) => isUnresolved(e) && !isTriaged(e))}, blocking a ticket: ${count((e) => isUnresolved(e) && blocksOf(e).length > 0)}`,
    "",
    "Debt gate (unfinished tickets):",
    ...gateLines(register, tickets).map((line) => `  ${line.replace(/\t/g, "  ")}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function compare(command, path, values) {
  if (!values.base) {
    throw new Error(`${command} needs --base <register>`);
  }
  if (command === "slice" && !TICKET.test(values.ticket ?? "")) {
    throw new Error("slice needs --ticket NN");
  }
  const base = parseRegister(readFileSync(values.base, "utf8"));
  const next = validRegister(path, values.root).register;
  const errors =
    command === "slice"
      ? sliceErrors(base, next, { ticket: values.ticket })
      : auditErrors(base, next);
  if (errors.length > 0) {
    throw new Error(`${path}: ${command} rules broken:\n${listed(errors)}`);
  }
}

const COMMANDS = {
  format(path, values) {
    writeFileSync(path, renderRegister(parseRegister(readFileSync(path, "utf8"))));
    validRegister(path, values.root);
  },
  check(path, values) {
    validRegister(path, values.root);
  },
  gate(path, values) {
    const { register, tickets } = validRegister(path, values.root);
    process.stdout.write(`${gateLines(register, tickets).join("\n")}\n`);
  },
  report(path, values) {
    const { register, tickets } = validRegister(path, values.root);
    report(register, tickets);
  },
  slice: (path, values) => compare("slice", path, values),
  audit: (path, values) => compare("audit", path, values),
};

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
  if (command === "record") {
    record(values);
    return;
  }
  const handler = Object.hasOwn(COMMANDS, command ?? "") ? COMMANDS[command ?? ""] : undefined;
  if (handler && path) {
    handler(path, values);
    return;
  }
  if (handler) {
    throw new Error(`${command} needs the register path`);
  }
  throw new Error(
    "usage: ralph-debt.mjs check|format|gate|report <register> | slice|audit <register> --base <file> | record --register ...",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`technical debt: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
