#!/usr/bin/env node
//
// Ralph's merge gate for the two-axis code review (skills/code-review). Reads the raw output of
// the Standards and Spec reviewer processes and checks each report's EVIDENCE against the real
// changeset and ticket: the commit range and token, that every changed file is accounted for,
// that every finding points at a changed file and a line inside one of its hunks, and (Spec) that
// every acceptance criterion has an outcome backed by tests that exist. Structural validity is
// not proof that a review is right; it only rules out reports that cannot be.
//
// Exits:
//   0  approved: both reports valid, no blocking finding, every criterion met or not applicable
//   1  blocked:  a finding at a blocking severity, or a criterion unmet, partial or unverifiable
//   2  invalid:  a reviewer failed or returned an invalid report; NEVER an approval
//
// Usage: node scripts/ralph-review.mjs --standards <file> --spec <file> --changeset <diff>
//          --base <sha> --head <sha> --report <file> --feedback <file> --decision <file>
//          --ticket <file> [--block CRITICAL,HIGH]
//        node scripts/ralph-review.mjs --check-block <severities>   (validate a policy only)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const FINDING_KINDS = [
  "defect",
  "security",
  "architecture",
  "maintainability",
  "missing_test",
  "unverified_assumption",
  "regression_risk",
  "spec_gap",
  "scope_creep",
];
const CRITERION_STATUSES = ["met", "partial", "unmet", "unverifiable", "not_applicable"];
// A required criterion that is not demonstrably met stops the merge like a HIGH finding would.
const FAILING_CRITERION_STATUSES = ["partial", "unmet", "unverifiable"];
const AXES = ["standards", "spec"];
const FINDING_TEXT_FIELDS = ["file", "rule", "title", "problem", "impact", "recommendation"];
const TOKEN_LINE = /^review-token: ([0-9a-f]+)$/;

export const EXIT = { approved: 0, blocked: 1, invalid: 2 };

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// --- Inputs -----------------------------------------------------------------------------------

/**
 * Changed files of a `git diff` with the line ranges of their hunks (new side; old side for a
 * deleted file), plus the review token the harness appended as the last line.
 */
export function parseChangeset(diffText) {
  const files = new Map();
  let token;
  let current;
  for (const line of diffText.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    const tokenMatch = TOKEN_LINE.exec(line);
    if (header) {
      current = { path: header[2], deleted: false, ranges: [] };
      files.set(current.path, current);
    } else if (current && line === "+++ /dev/null") {
      current.deleted = true;
    } else if (current && hunk) {
      const [start, count] = current.deleted ? [hunk[1], hunk[2]] : [hunk[3], hunk[4]];
      const first = Number(start);
      current.ranges.push([first, first + Math.max(Number(count ?? 1), 1) - 1]);
    } else if (tokenMatch) {
      token = tokenMatch[1];
    }
  }
  return { files, token };
}

/** Acceptance criteria are the ticket's checkbox lines, numbered AC1..ACn in order. */
export function parseCriteria(ticketText) {
  return ticketText
    .split("\n")
    .filter((line) => /^- \[[ xX]\] /.test(line))
    .map((line, index) => ({ id: `AC${index + 1}`, text: line.slice(6).trim() }));
}

// The reviewer process prints Claude Code's `--output-format=json` envelope, whose
// `structured_output` holds the schema-checked report. A bare report is accepted too, so any
// agent CLI that prints the report itself can be plugged in.
export function extractReport(rawOutput) {
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return { error: "output is not JSON" };
  }
  if (!isObject(parsed)) {
    return { error: "output is not a JSON object" };
  }
  if (parsed.type !== "result") {
    return { report: parsed };
  }
  if (parsed.is_error !== false || parsed.subtype !== "success") {
    return { error: `agent run failed (subtype ${parsed.subtype}, is_error ${parsed.is_error})` };
  }
  if (parsed.structured_output === undefined) {
    return { error: "agent result has no structured_output" };
  }
  return { report: parsed.structured_output };
}

// --- Validation (mirrors skills/code-review/report.schema.json, then checks the evidence) -------

function changesetErrors(report, context) {
  const changeset = report.changeset;
  if (!isObject(changeset)) {
    return ["changeset must be an object with base, head and token"];
  }
  const errors = [];
  if (changeset.base !== context.base || changeset.head !== context.head) {
    errors.push(
      `changeset range ${changeset.base}..${changeset.head} is not the reviewed range ` +
        `${context.base}..${context.head}`,
    );
  }
  // The token is the changeset file's last line and appears nowhere else, so echoing it proves the
  // reviewer opened the changeset and read it to the end, instead of reviewing other files.
  if (!context.token || changeset.token !== context.token) {
    errors.push("changeset.token does not match: the reviewer did not read the whole changeset");
  }
  return errors;
}

function fileCoverageErrors(report, context) {
  if (!Array.isArray(report.files)) {
    return ["files must list every changed file"];
  }
  const errors = [];
  const seen = new Set();
  for (const [index, entry] of report.files.entries()) {
    const where = `files[${index}]`;
    if (!(isObject(entry) && context.files.has(entry.path))) {
      errors.push(`${where}.path ${JSON.stringify(entry?.path)} is not a file in the changeset`);
      continue;
    }
    seen.add(entry.path);
    if (entry.status !== "reviewed" && entry.status !== "not_relevant") {
      errors.push(`${where}.status must be "reviewed" or "not_relevant"`);
    } else if (entry.status === "not_relevant" && !isNonEmptyString(entry.note)) {
      errors.push(`${where} is marked not_relevant without a justification in note`);
    }
  }
  const missing = [...context.files.keys()].filter((path) => !seen.has(path));
  if (missing.length > 0) {
    errors.push(`files does not account for: ${missing.join(", ")}`);
  }
  return errors;
}

function locationError(finding, where, context) {
  const file = context.files.get(finding.file);
  if (!file) {
    return `${where}.file ${JSON.stringify(finding.file)} is not a file in the changeset`;
  }
  const inHunk = file.ranges.some(([first, last]) => finding.line >= first && finding.line <= last);
  if (finding.line !== 0 && !inHunk) {
    return `${where}.line ${finding.line} is not inside a hunk of ${finding.file} (use 0 for the whole file)`;
  }
  return undefined;
}

function findingErrors(finding, index, context) {
  const where = `findings[${index}]`;
  if (!isObject(finding)) {
    return [`${where} is not an object`];
  }
  const errors = [];
  if (!SEVERITIES.includes(finding.severity)) {
    errors.push(`${where}.severity must be one of ${SEVERITIES.join(", ")}`);
  }
  if (!FINDING_KINDS.includes(finding.kind)) {
    errors.push(`${where}.kind must be one of ${FINDING_KINDS.join(", ")}`);
  }
  for (const field of FINDING_TEXT_FIELDS) {
    if (!isNonEmptyString(finding[field])) {
      errors.push(`${where}.${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(finding.line) || finding.line < 0) {
    errors.push(`${where}.line must be a non-negative integer`);
  } else if (isNonEmptyString(finding.file)) {
    const error = locationError(finding, where, context);
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}

// A test reference is `path` or `path::test name`; the path must exist in the workspace.
const testPathExists = (reference, context) =>
  isNonEmptyString(reference) && context.pathExists(reference.split("::")[0].trim());

function criterionErrors(entry, where, context) {
  if (!CRITERION_STATUSES.includes(entry.status)) {
    return [`${where}.status must be one of ${CRITERION_STATUSES.join(", ")}`];
  }
  const errors = [];
  const tests = Array.isArray(entry.tests) ? entry.tests : [];
  if (entry.status === "met") {
    if (!isNonEmptyString(entry.evidence)) {
      errors.push(`${where} is met but names no implementation evidence`);
    }
    if (tests.length === 0) {
      errors.push(`${where} is met but names no test that verifies it`);
    }
  } else if (!isNonEmptyString(entry.note)) {
    errors.push(`${where} is ${entry.status} without an explanation in note`);
  }
  for (const reference of tests.filter((test) => !testPathExists(test, context))) {
    errors.push(`${where}.tests references ${JSON.stringify(reference)}, which does not exist`);
  }
  return errors;
}

function criteriaErrors(report, context) {
  if (!Array.isArray(report.criteria)) {
    return ["criteria must be an array"];
  }
  if (report.axis !== "spec") {
    return [];
  }
  if (context.criteria.length === 0) {
    return ["the ticket has no acceptance criteria to review against"];
  }
  const errors = [];
  const expected = new Set(context.criteria.map((criterion) => criterion.id));
  const seen = new Set();
  for (const [index, entry] of report.criteria.entries()) {
    const where = `criteria[${index}]`;
    if (!(isObject(entry) && expected.has(entry.id)) || seen.has(entry.id)) {
      errors.push(
        `${where}.id ${JSON.stringify(entry?.id)} is not an acceptance criterion or repeats`,
      );
      continue;
    }
    seen.add(entry.id);
    errors.push(...criterionErrors(entry, `${where} (${entry.id})`, context));
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    errors.push(`criteria has no outcome for: ${missing.join(", ")}`);
  }
  return errors;
}

export function validateReport(report, expectedAxis, context) {
  if (!isObject(report)) {
    return ["report is not an object"];
  }
  const errors = [];
  if (report.axis !== expectedAxis) {
    errors.push(`axis must be "${expectedAxis}" (got ${JSON.stringify(report.axis)})`);
  }
  if (report.status !== "reviewed") {
    // `skipped` is valid for the skill but not for Ralph: every ticket has a spec, and an axis
    // that did not review cannot approve.
    errors.push(`status must be "reviewed" (got ${JSON.stringify(report.status)})`);
  }
  for (const field of ["reviewer", "summary"]) {
    if (!isNonEmptyString(report[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  errors.push(...changesetErrors(report, context));
  errors.push(...fileCoverageErrors(report, context));
  errors.push(...criteriaErrors(report, context));
  if (Array.isArray(report.findings)) {
    for (const [index, finding] of report.findings.entries()) {
      errors.push(...findingErrors(finding, index, context));
    }
  } else {
    errors.push("findings must be an array");
  }
  return errors;
}

export function parseBlocking(list) {
  const severities = list
    .split(",")
    .map((severity) => severity.trim())
    .filter(Boolean);
  const unknown = severities.filter((severity) => !SEVERITIES.includes(severity));
  if (severities.length === 0 || unknown.length > 0) {
    throw new Error(`--block must list severities from ${SEVERITIES.join(", ")} (got "${list}")`);
  }
  return severities;
}

// --- Rendering --------------------------------------------------------------------------------

const bySeverity = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);

function renderFinding(finding) {
  return [
    `### [${finding.severity}] ${finding.title}`,
    "",
    `- **Where:** \`${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}\` (${finding.kind})`,
    `- **Rule:** ${finding.rule}`,
    `- **Problem:** ${finding.problem}`,
    `- **Impact:** ${finding.impact}`,
    `- **Fix:** ${finding.recommendation}`,
    "",
  ].join("\n");
}

function renderCriteria(criteria) {
  if (criteria.length === 0) {
    return "";
  }
  const rows = criteria.map(
    (entry) =>
      `| ${entry.id} | ${entry.status} | ${(entry.tests ?? []).join("<br>") || "-"} | ${
        entry.note || entry.evidence || ""
      } |`,
  );
  return ["| Criterion | Outcome | Tests | Notes |", "| --- | --- | --- | --- |", ...rows, ""].join(
    "\n",
  );
}

function renderAxis(title, result) {
  if (result.errors.length > 0) {
    return `## ${title}\n\n**INVALID REPORT** (treated as a failed review):\n\n${result.errors
      .map((error) => `- ${error}`)
      .join("\n")}\n`;
  }
  const { report } = result;
  const notRelevant = report.files.filter((entry) => entry.status === "not_relevant");
  const coverage = `Files: ${report.files.length - notRelevant.length} reviewed, ${notRelevant.length} not relevant${
    notRelevant.length > 0
      ? ` (${notRelevant.map((entry) => `${entry.path}: ${entry.note}`).join("; ")})`
      : ""
  }. Reviewer: ${report.reviewer}.`;
  const findings = [...report.findings].sort(bySeverity);
  const body = findings.length === 0 ? "No findings.\n" : findings.map(renderFinding).join("\n");
  return `## ${title}\n\n${report.summary}\n\n${coverage}\n\n${renderCriteria(report.criteria)}\n${body}`;
}

function countLine(result) {
  if (result.errors.length > 0) {
    return "invalid";
  }
  return SEVERITIES.map(
    (severity) =>
      `${result.report.findings.filter((finding) => finding.severity === severity).length} ${severity}`,
  ).join(", ");
}

// --- Decision ---------------------------------------------------------------------------------

function criterionBlockers(report) {
  return report.criteria
    .filter((entry) => FAILING_CRITERION_STATUSES.includes(entry.status))
    .map((entry) => ({
      severity: "HIGH",
      kind: "spec_gap",
      file: "(acceptance criteria)",
      line: 0,
      rule: entry.id,
      title: `Acceptance criterion ${entry.id} is ${entry.status}`,
      problem: entry.note,
      impact: "The ticket is not done until every acceptance criterion is demonstrably met.",
      recommendation: "Implement the criterion and add a test that proves it.",
      axis: "spec",
    }));
}

// Each axis is judged and rendered on its own; findings are never merged or reranked across axes
// (see "Why two axes" in skills/code-review/SKILL.md).
export function evaluate({ standardsOutput, specOutput, blocking, context }) {
  const results = {};
  for (const [axis, output] of [
    ["standards", standardsOutput],
    ["spec", specOutput],
  ]) {
    const extracted = extractReport(output);
    results[axis] = extracted.error
      ? { errors: [extracted.error] }
      : { report: extracted.report, errors: validateReport(extracted.report, axis, context) };
  }

  const invalid = AXES.some((axis) => results[axis].errors.length > 0);
  const blockers = invalid
    ? []
    : [
        ...AXES.flatMap((axis) =>
          results[axis].report.findings
            .filter((finding) => blocking.includes(finding.severity))
            .map((finding) => ({ ...finding, axis })),
        ),
        ...criterionBlockers(results.spec.report),
      ].sort(bySeverity);

  let verdict = "approved";
  if (invalid) {
    verdict = "invalid";
  } else if (blockers.length > 0) {
    verdict = "blocked";
  }

  const report = [
    `# Code review: ${verdict.toUpperCase()}`,
    "",
    `Changeset ${context.base}..${context.head}, ${context.files.size} file(s). Blocking severities: ${blocking.join(", ")}.`,
    `Standards: ${countLine(results.standards)}. Spec: ${countLine(results.spec)}.`,
    "",
    renderAxis("Standards", results.standards),
    renderAxis("Spec", results.spec),
  ].join("\n");

  const feedback = blockers
    .map((finding) => `(${finding.axis} axis)\n${renderFinding(finding)}`)
    .join("\n");

  const decision = {
    verdict,
    base: context.base,
    head: context.head,
    token: context.token ?? null,
    files: [...context.files.keys()],
    criteria: context.criteria.map((criterion) => criterion.id),
    blocking,
    errors: { standards: results.standards.errors, spec: results.spec.errors },
    blockers: blockers.map(({ axis, severity, title }) => ({ axis, severity, title })),
  };
  return { verdict, report, feedback, decision };
}

// --- CLI --------------------------------------------------------------------------------------

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

function main() {
  const { values } = parseArgs({
    options: {
      standards: { type: "string" },
      spec: { type: "string" },
      changeset: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      ticket: { type: "string" },
      report: { type: "string" },
      feedback: { type: "string" },
      decision: { type: "string" },
      block: { type: "string", default: "CRITICAL,HIGH" },
      "check-block": { type: "string" },
    },
  });
  if (values["check-block"] !== undefined) {
    parseBlocking(values["check-block"]);
    return;
  }
  for (const name of [
    "standards",
    "spec",
    "changeset",
    "base",
    "head",
    "ticket",
    "report",
    "feedback",
    "decision",
  ]) {
    if (!values[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  const changeset = parseChangeset(readText(values.changeset));
  const result = evaluate({
    standardsOutput: readText(values.standards),
    specOutput: readText(values.spec),
    blocking: parseBlocking(values.block),
    context: {
      base: values.base,
      head: values.head,
      token: changeset.token,
      files: changeset.files,
      criteria: parseCriteria(readText(values.ticket)),
      // Test references are workspace-relative; anything else cannot name a test of this repo.
      pathExists: (path) =>
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.split(/[\\/]/).includes("..") &&
        existsSync(path),
    },
  });
  writeFileSync(values.report, `${result.report}\n`);
  writeFileSync(values.feedback, result.feedback);
  writeFileSync(values.decision, `${JSON.stringify(result.decision, null, 2)}\n`);
  console.error(`code review: ${result.verdict} (report: ${values.report})`);
  process.exitCode = EXIT[result.verdict];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`code review: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.invalid;
  }
}
