#!/usr/bin/env node
//
// Stand-in for a `claude -p` reviewer in the harness scenario tests (scripts/ralph-loop.test.sh,
// scripts/sandbox.test.sh). Like a real reviewer it learns everything from the prompt (last
// argument): its axis, the commit range, the changeset file, the changed files and the acceptance
// criteria. Like `--restricted` it can only open the changeset inside its working directory, and
// only reading it yields the token. STUB_REVIEW picks the behaviour; STUB_CALLS logs each run.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const prompt = process.argv.at(-1) ?? "";
// Configured like any test double, by the scenario's environment.
const { STUB_REVIEW: mode = "clean", STUB_CALLS: callsFile } = process.env;
const axis = prompt.includes("Standards sub-agent") ? "standards" : "spec";
if (callsFile) {
  appendFileSync(callsFile, `${axis}\n`);
}

const [, base = "", head = ""] = /Commit range: base (\S+), head (\S+)/.exec(prompt) ?? [];
const changesetPath = /^- Changeset file: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
const changedSection = /^- Changed files[^\n]*\n((?: {2}\S[^\n]*\n)*)/m.exec(prompt)?.[1] ?? "";
const changed = changedSection
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const criteriaIds = [...prompt.matchAll(/^ {2}(AC\d+): /gm)].map((match) => match[1]);

function readToken() {
  const absolute = resolve(changesetPath);
  const inside = absolute.startsWith(`${process.cwd()}${sep}`);
  if (!(changesetPath && inside && existsSync(absolute))) {
    return "";
  }
  return /^review-token: (\S+)$/m.exec(readFileSync(absolute, "utf8"))?.[1] ?? "";
}

const target = changed.find((path) => path === "feature.txt") ?? changed[0] ?? "";
const finding = (severity, overrides = {}) => ({
  severity,
  kind: "defect",
  file: target,
  line: 1,
  rule: "stub rule",
  title: `stub ${severity} finding`,
  problem: "p",
  impact: "i",
  recommendation: "fix it",
  ...overrides,
});
const met = (id) => ({ id, status: "met", evidence: `${target}:1`, tests: [target], note: "" });

const report = {
  axis,
  status: "reviewed",
  reviewer: `stub ${axis} reviewer`,
  changeset: { base, head, token: readToken() },
  summary: "stub review",
  files: changed.map((path) => ({ path, status: "reviewed", note: "" })),
  criteria: axis === "spec" ? criteriaIds.map(met) : [],
  findings: [],
};

// Each mode changes one axis only, so the other axis's report stays valid.
const behaviours = {
  "medium:standards": () => report.findings.push(finding("MEDIUM")),
  "high:standards": () => report.findings.push(finding("HIGH")),
  "critical:spec": () => report.findings.push(finding("CRITICAL")),
  "bug:standards": () => existsSync("bug.txt") && report.findings.push(finding("HIGH")),
  "noread:standards": () => {
    report.changeset.token = "";
  },
  "badfile:standards": () => report.findings.push(finding("LOW", { file: "src/invented.ts" })),
  "badline:standards": () => report.findings.push(finding("LOW", { line: 999 })),
  "uncovered:standards": () => report.files.pop(),
  "range:standards": () => {
    report.changeset.head = report.changeset.base;
  },
  "skip:spec": () => {
    report.status = "skipped";
  },
  "nocriteria:spec": () => report.criteria.pop(),
  "faketest:spec": () => {
    report.criteria[0] = { ...met(criteriaIds[0]), tests: ["src/invented.test.ts::passes"] };
  },
  "unmet:spec": () => {
    report.criteria[0] = { ...met(criteriaIds[0]), status: "unmet", tests: [], note: "not built" };
  },
  "tamper:standards": () => writeFileSync("tampered.txt", "sneaky\n"),
};

const print = (text) => process.stdout.write(`${text}\n`);

switch (`${mode}:${axis}`) {
  case "crash:standards":
    process.exit(1);
    break;
  case "garbage:standards":
    print("LGTM, ship it");
    break;
  case "error:standards":
    print(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    break;
  default:
    behaviours[`${mode}:${axis}`]?.();
    print(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: report,
      }),
    );
}
