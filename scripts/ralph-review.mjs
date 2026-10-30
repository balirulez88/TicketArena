#!/usr/bin/env node
//
// Ralph's merge gate for the two-axis code review (skills/code-review). Reads the raw output of
// the Standards and Spec reviewer processes, validates both reports, writes a human report and
// the blocking findings for the fix agent, and exits:
//   0  approved: both reports valid and no finding at a blocking severity
//   1  blocked:  at least one blocking finding
//   2  invalid:  a reviewer failed or returned an invalid report; NEVER an approval
//
// Usage: node scripts/ralph-review.mjs --standards <file> --spec <file> --report <file>
//          --feedback <file> [--block CRITICAL,HIGH] [--token <changeset token>]
//        node scripts/ralph-review.mjs --check-block <severities>   (validate a policy only)

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const AXES = ["standards", "spec"];
const FINDING_TEXT_FIELDS = ["file", "rule", "title", "problem", "impact", "recommendation"];

export const EXIT = { approved: 0, blocked: 1, invalid: 2 };

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

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
  if (parsed === null || typeof parsed !== "object") {
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

function findingErrors(finding, index) {
  const where = `findings[${index}]`;
  if (finding === null || typeof finding !== "object") {
    return [`${where} is not an object`];
  }
  const errors = [];
  if (!SEVERITIES.includes(finding.severity)) {
    errors.push(`${where}.severity must be one of ${SEVERITIES.join(", ")}`);
  }
  if (!Number.isInteger(finding.line) || finding.line < 0) {
    errors.push(`${where}.line must be a non-negative integer`);
  }
  for (const field of FINDING_TEXT_FIELDS) {
    if (!isNonEmptyString(finding[field])) {
      errors.push(`${where}.${field} must be a non-empty string`);
    }
  }
  return errors;
}

// Mirrors skills/code-review/report.schema.json. Validated again here because the schema is
// only a request to the agent; the gate must not trust that it was honoured.
export function validateReport(report, expectedAxis, token) {
  if (report === null || typeof report !== "object") {
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
  if (!isNonEmptyString(report.summary)) {
    errors.push("summary must be a non-empty string");
  }
  // The token is the changeset file's last line and appears nowhere else, so echoing it proves the
  // reviewer opened the changeset and read it to the end, instead of reviewing other files.
  if (token !== undefined && report.changeset_token !== token) {
    errors.push("changeset_token does not match: the reviewer did not read the whole changeset");
  }
  if (Array.isArray(report.findings)) {
    for (const [index, finding] of report.findings.entries()) {
      errors.push(...findingErrors(finding, index));
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

const bySeverity = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);

function renderFinding(finding) {
  return [
    `### [${finding.severity}] ${finding.title}`,
    "",
    `- **Where:** \`${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}\``,
    `- **Rule:** ${finding.rule}`,
    `- **Problem:** ${finding.problem}`,
    `- **Impact:** ${finding.impact}`,
    `- **Fix:** ${finding.recommendation}`,
    "",
  ].join("\n");
}

function renderAxis(title, result) {
  if (result.errors.length > 0) {
    return `## ${title}\n\n**INVALID REPORT** (treated as a failed review):\n\n${result.errors
      .map((error) => `- ${error}`)
      .join("\n")}\n`;
  }
  const findings = [...result.report.findings].sort(bySeverity);
  const body = findings.length === 0 ? "No findings.\n" : findings.map(renderFinding).join("\n");
  return `## ${title}\n\n${result.report.summary}\n\n${body}`;
}

function countLine(result) {
  if (result.errors.length > 0) {
    return "invalid";
  }
  const counts = SEVERITIES.map(
    (severity) =>
      `${result.report.findings.filter((finding) => finding.severity === severity).length} ${severity}`,
  );
  return counts.join(", ");
}

// Each axis is judged and rendered on its own; findings are never merged or reranked across axes
// (see "Why two axes" in skills/code-review/SKILL.md).
export function evaluate({ standardsOutput, specOutput, blocking, token }) {
  const results = {};
  for (const [axis, output] of [
    ["standards", standardsOutput],
    ["spec", specOutput],
  ]) {
    const extracted = extractReport(output);
    results[axis] = extracted.error
      ? { errors: [extracted.error] }
      : { report: extracted.report, errors: validateReport(extracted.report, axis, token) };
  }

  const invalid = AXES.some((axis) => results[axis].errors.length > 0);
  const blockers = invalid
    ? []
    : AXES.flatMap((axis) =>
        results[axis].report.findings
          .filter((finding) => blocking.includes(finding.severity))
          .map((finding) => ({ ...finding, axis })),
      ).sort(bySeverity);

  let verdict = "approved";
  if (invalid) {
    verdict = "invalid";
  } else if (blockers.length > 0) {
    verdict = "blocked";
  }

  const report = [
    `# Code review: ${verdict.toUpperCase()}`,
    "",
    `Blocking severities: ${blocking.join(", ")}.`,
    `Standards: ${countLine(results.standards)}. Spec: ${countLine(results.spec)}.`,
    "",
    renderAxis("Standards", results.standards),
    renderAxis("Spec", results.spec),
  ].join("\n");

  const feedback = blockers
    .map((finding) => `(${finding.axis} axis)\n${renderFinding(finding)}`)
    .join("\n");

  return { verdict, report, feedback };
}

function main() {
  const { values } = parseArgs({
    options: {
      standards: { type: "string" },
      spec: { type: "string" },
      report: { type: "string" },
      feedback: { type: "string" },
      block: { type: "string", default: "CRITICAL,HIGH" },
      "check-block": { type: "string" },
      token: { type: "string" },
    },
  });
  if (values["check-block"] !== undefined) {
    parseBlocking(values["check-block"]);
    return;
  }
  for (const name of ["standards", "spec", "report", "feedback"]) {
    if (!values[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  const readOutput = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const result = evaluate({
    standardsOutput: readOutput(values.standards),
    specOutput: readOutput(values.spec),
    blocking: parseBlocking(values.block),
    token: values.token,
  });
  writeFileSync(values.report, `${result.report}\n`);
  writeFileSync(values.feedback, result.feedback);
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
