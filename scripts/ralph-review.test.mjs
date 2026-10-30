import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  annotateChangeset,
  evaluate,
  parseBlocking,
  parseChangeset,
  parseCriteria,
} from "./ralph-review.mjs";

const BLOCKING = ["CRITICAL", "HIGH"];
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TOKEN = "0123456789abcdef";

// A real `git diff` shape: a modified file with two hunks, a new file and a deleted file.
const DIFF = `diff --git a/packages/booking/src/hold.ts b/packages/booking/src/hold.ts
index 1111111..2222222 100644
--- a/packages/booking/src/hold.ts
+++ b/packages/booking/src/hold.ts
@@ -10,6 +10,8 @@ export function hold() {
 context
+added
+added
@@ -40,3 +42,5 @@ export function release() {
+added
diff --git a/packages/booking/src/hold.test.ts b/packages/booking/src/hold.test.ts
new file mode 100644
--- /dev/null
+++ b/packages/booking/src/hold.test.ts
@@ -0,0 +1,20 @@
+test
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
--- a/docs/old.md
+++ /dev/null
@@ -1,4 +0,0 @@
-gone

review-token: ${TOKEN}
`;

const TICKET = `# 99: Hold seats

## Acceptance criteria

- [ ] A hold locks the seats.
- [x] A released hold frees them.
- not a criterion
`;

const EXISTING = new Set(["packages/booking/src/hold.test.ts"]);
const changeset = parseChangeset(DIFF);
const CONTEXT = {
  base: BASE,
  head: HEAD,
  token: changeset.token,
  files: changeset.files,
  criteria: parseCriteria(TICKET),
  pathExists: (path) => EXISTING.has(path),
};

const finding = (severity, overrides = {}) => ({
  severity,
  kind: "defect",
  file: "packages/booking/src/hold.ts",
  line: 42,
  rule: "docs/workflow/code-review.md: lock order",
  title: `${severity} finding`,
  problem: "Seats are locked before the hold.",
  impact: "Two buyers can deadlock.",
  recommendation: "Lock the hold first, then seats ORDER BY id.",
  ...overrides,
});

const met = (id) => ({
  id,
  status: "met",
  evidence: "packages/booking/src/hold.ts:12",
  tests: ["packages/booking/src/hold.test.ts::holds and releases"],
  note: "",
});

const allFiles = () =>
  [...changeset.files.keys()].map((path) => ({ path, status: "reviewed", note: "" }));

const report = (axis, overrides = {}) => ({
  axis,
  status: "reviewed",
  reviewer: `${axis} sub-agent (test)`,
  changeset: { base: BASE, head: HEAD, token: TOKEN },
  summary: `${axis} reviewed`,
  files: allFiles(),
  criteria: axis === "spec" ? [met("AC1"), met("AC2")] : [],
  findings: [],
  ...overrides,
});

// What `claude -p --output-format=json --json-schema ...` prints.
const envelope = (structuredOutput, overrides = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: structuredOutput,
    ...overrides,
  });

const run = (standards, spec, context = CONTEXT) =>
  evaluate({ standardsOutput: standards, specOutput: spec, blocking: BLOCKING, context });

const runReports = (standards, spec) => run(envelope(standards), envelope(spec));

const assertInvalid = (result, pattern) => {
  assert.equal(result.verdict, "invalid");
  assert.match(result.report, /INVALID REPORT/);
  assert.match(result.report, pattern);
  assert.equal(result.feedback, "");
};

describe("changeset and ticket parsing", () => {
  it("finds every changed file, its hunk ranges and the token", () => {
    assert.deepEqual(
      [...changeset.files.keys()],
      ["packages/booking/src/hold.ts", "packages/booking/src/hold.test.ts", "docs/old.md"],
    );
    assert.deepEqual(changeset.files.get("packages/booking/src/hold.ts")?.ranges, [
      [10, 17],
      [42, 46],
    ]);
    assert.deepEqual(changeset.files.get("docs/old.md")?.ranges, [[1, 4]]);
    assert.equal(changeset.token, TOKEN);
  });

  it("numbers the checkbox lines of a ticket as acceptance criteria", () => {
    assert.deepEqual(parseCriteria(TICKET), [
      { id: "AC1", text: "A hold locks the seats." },
      { id: "AC2", text: "A released hold frees them." },
    ]);
  });
});

describe("ralph review gate: verdicts", () => {
  it("approves complete, well-evidenced reports without blocking findings", () => {
    const result = runReports(report("standards"), report("spec"));
    assert.equal(result.verdict, "approved");
    assert.equal(result.feedback, "");
    assert.match(result.report, /Files: 3 reviewed, 0 not relevant/);
    assert.match(result.report, /\| AC1 \| met \|/);
    assert.equal(result.decision.verdict, "approved");
    assert.deepEqual(result.decision.criteria, ["AC1", "AC2"]);
  });

  it("approves with only non-blocking findings and still reports them", () => {
    const result = runReports(
      report("standards", { findings: [finding("MEDIUM"), finding("LOW", { line: 0 })] }),
      report("spec"),
    );
    assert.equal(result.verdict, "approved");
    assert.match(result.report, /\[MEDIUM\] MEDIUM finding/);
  });

  it("blocks on a HIGH finding in either axis", () => {
    const result = runReports(report("standards"), report("spec", { findings: [finding("HIGH")] }));
    assert.equal(result.verdict, "blocked");
    assert.match(result.feedback, /\(spec axis\)/);
    assert.match(result.feedback, /Lock the hold first/);
    assert.deepEqual(result.decision.blockers, [
      { axis: "spec", severity: "HIGH", title: "HIGH finding" },
    ]);
  });

  it("blocks on a CRITICAL finding and lists it first", () => {
    const result = runReports(
      report("standards", { findings: [finding("HIGH"), finding("CRITICAL")] }),
      report("spec"),
    );
    assert.equal(result.verdict, "blocked");
    assert.ok(result.feedback.indexOf("[CRITICAL]") < result.feedback.indexOf("[HIGH]"));
  });

  for (const status of ["unmet", "partial", "unverifiable"]) {
    it(`blocks when an acceptance criterion is ${status}`, () => {
      const criterion = {
        id: "AC2",
        status,
        evidence: "",
        tests: [],
        note: "No test frees seats.",
      };
      const result = runReports(
        report("standards"),
        report("spec", { criteria: [met("AC1"), criterion] }),
      );
      assert.equal(result.verdict, "blocked");
      assert.match(result.feedback, new RegExp(`AC2 is ${status}`));
    });
  }

  it("accepts a not_applicable criterion with a reason", () => {
    const na = {
      id: "AC2",
      status: "not_applicable",
      evidence: "",
      tests: [],
      note: "Superseded.",
    };
    const result = runReports(report("standards"), report("spec", { criteria: [met("AC1"), na] }));
    assert.equal(result.verdict, "approved");
  });
});

describe("ralph review gate: evidence that cannot be right is INVALID, never approved", () => {
  const invalidCases = [
    [
      "a report whose token does not match",
      { changeset: { base: BASE, head: HEAD, token: "f00d" } },
      /token does not match/,
    ],
    [
      "a report with an empty token",
      { changeset: { base: BASE, head: HEAD, token: "" } },
      /token does not match/,
    ],
    [
      "a report for another commit range",
      { changeset: { base: BASE, head: BASE, token: TOKEN } },
      /not the reviewed range/,
    ],
    [
      "a finding in a file outside the changeset",
      { findings: [finding("LOW", { file: "src/other.ts" })] },
      /not a file in the changeset/,
    ],
    [
      "a finding at a line outside every hunk",
      { findings: [finding("LOW", { line: 30 })] },
      /line 30 is not inside a hunk/,
    ],
    [
      "a finding without a kind",
      { findings: [finding("LOW", { kind: "opinion" })] },
      /kind must be one of/,
    ],
    [
      "a finding with a negative line",
      { findings: [finding("LOW", { line: -1 })] },
      /non-negative integer/,
    ],
    [
      "a report that skips a changed file",
      { files: allFiles().slice(1) },
      /does not account for: packages\/booking\/src\/hold\.ts/,
    ],
    [
      "a file covered with an unknown path",
      { files: [...allFiles(), { path: "x.ts", status: "reviewed", note: "" }] },
      /"x\.ts" is not a file in the changeset/,
    ],
    [
      "a file waved through as not_relevant without a reason",
      { files: allFiles().map((f) => ({ ...f, status: "not_relevant" })) },
      /not_relevant without a justification/,
    ],
    ["a report without a reviewer", { reviewer: " " }, /reviewer must be a non-empty string/],
    ["a skipped review", { status: "skipped" }, /status must be "reviewed"/],
  ];
  for (const [name, overrides, pattern] of invalidCases) {
    it(`rejects ${name}`, () => {
      assertInvalid(runReports(report("standards", overrides), report("spec")), pattern);
    });
  }

  it("rejects a spec report that leaves an acceptance criterion without an outcome", () => {
    const result = runReports(report("standards"), report("spec", { criteria: [met("AC1")] }));
    assertInvalid(result, /no outcome for: AC2/);
  });

  it("rejects a criterion id the ticket does not have, or a repeated one", () => {
    const result = runReports(
      report("standards"),
      report("spec", { criteria: [met("AC1"), met("AC1"), met("AC7")] }),
    );
    assertInvalid(result, /"AC1" is not an acceptance criterion or repeats/);
    assert.match(result.report, /"AC7"/);
  });

  it("rejects a criterion marked met without a verifying test", () => {
    const result = runReports(
      report("standards"),
      report("spec", { criteria: [met("AC1"), { ...met("AC2"), tests: [] }] }),
    );
    assertInvalid(result, /AC2\) is met but names no test/);
  });

  it("rejects a test reference that does not exist", () => {
    const ghost = { ...met("AC2"), tests: ["packages/booking/src/ghost.test.ts::frees seats"] };
    const result = runReports(
      report("standards"),
      report("spec", { criteria: [met("AC1"), ghost] }),
    );
    assertInvalid(result, /ghost\.test\.ts::frees seats", which does not exist/);
  });

  it("rejects a criterion that is not met without saying why", () => {
    const silent = { id: "AC2", status: "unmet", evidence: "", tests: [], note: "" };
    const result = runReports(
      report("standards"),
      report("spec", { criteria: [met("AC1"), silent] }),
    );
    assertInvalid(result, /AC2\) is unmet without an explanation/);
  });

  it("rejects a spec review when the ticket has no acceptance criteria", () => {
    const result = run(envelope(report("standards")), envelope(report("spec", { criteria: [] })), {
      ...CONTEXT,
      criteria: [],
    });
    assertInvalid(result, /no acceptance criteria/);
  });

  it("rejects reports swapped between the axes", () => {
    assertInvalid(runReports(report("spec"), report("standards")), /axis must be "standards"/);
  });

  it("does not approve when a valid report hides a blocking finding behind an invalid one", () => {
    const result = runReports(
      report("standards", { findings: [finding("CRITICAL")] }),
      report("spec", { files: [] }),
    );
    assert.equal(result.verdict, "invalid");
  });

  it("rejects output that is not JSON, a failed agent run and a missing structured_output", () => {
    assertInvalid(run("not json", envelope(report("spec"))), /output is not JSON/);
    assertInvalid(
      run(
        envelope(report("standards"), { is_error: true, subtype: "error_max_turns" }),
        envelope(report("spec")),
      ),
      /agent run failed/,
    );
    assertInvalid(run(envelope(undefined), envelope(report("spec"))), /no structured_output/);
  });

  it("accepts a bare report from an agent CLI without the envelope", () => {
    const result = run(JSON.stringify(report("standards")), JSON.stringify(report("spec")));
    assert.equal(result.verdict, "approved");
  });

  it("records why a review was invalid in the decision", () => {
    const result = runReports(report("standards", { files: [] }), report("spec"));
    assert.equal(result.decision.verdict, "invalid");
    assert.ok(result.decision.errors.standards.length > 0);
    assert.deepEqual(result.decision.errors.spec, []);
  });
});

// The changeset of the failure-injection experiment, exactly as real reviewers received it: the
// defect (`principal.kind === "user" || ...`) is line 27 of hold-access.ts and line 69 of this
// file. Every real report cited 69, so every review was invalid instead of blocked.
const OBSERVED = readFileSync(
  new URL("./fixtures/hold-access.review.diff", import.meta.url),
  "utf8",
)
  .replace(/\r\n/g, "\n")
  .replace(/\nreview-token: .*\n?$/, "\n");
const DEFECT = '+  if (principal.kind === "user" || hold.buyerKey === buyerKey(principal)) {';
const DEFECT_FILE = "apps/web/src/server/holds/hold-access.ts";

describe("annotated changeset: source line numbers, not diff positions", () => {
  const annotated = annotateChangeset(OBSERVED);
  const lines = annotated.split("\n");

  it("puts the defect's source line 27 in front of it, while it sits elsewhere in the file", () => {
    const position = lines.findIndex((line) => line.endsWith(DEFECT)) + 1;
    assert.equal(lines[position - 1], `    .    27 | ${DEFECT}`);
    assert.notEqual(position, 27);
    assert.equal(OBSERVED.split("\n").indexOf(DEFECT) + 1, 69);
  });

  it("explains the numbers before the first file", () => {
    assert.ok(annotated.indexOf("SOURCE-FILE line numbers") < annotated.indexOf("diff --git"));
    assert.match(annotated, /never positions within this changeset file/);
  });

  it("numbers old and new sides of a modified hunk, removed and unchanged lines included", () => {
    const ticketHunk = lines.slice(lines.findIndex((line) => line.startsWith("@@ -6,7 +6,7 @@")));
    assert.match(ticketHunk[1] ?? "", /^ {4}6 {5}6 \| {2}/);
    const removed = ticketHunk.find((line) => line.includes("| -**Status:**"));
    const added = ticketHunk.find((line) => line.includes("| +**Status:**"));
    assert.match(removed ?? "", /^ {4}9 {5}\. \| -/);
    assert.match(added ?? "", /^ {4}\. {5}9 \| \+/);
  });

  it("uses old-side numbers only for a deleted file and leaves no-newline markers unnumbered", () => {
    const deleted = annotateChangeset(
      "diff --git a/old.md b/old.md\ndeleted file mode 100644\n--- a/old.md\n+++ /dev/null\n" +
        "@@ -1,2 +0,0 @@\n-first\n-second\n\\ No newline at end of file\n",
    ).split("\n");
    assert.deepEqual(deleted.slice(-4, -1), [
      "    1     . | -first",
      "    2     . | -second",
      "    .     . | \\ No newline at end of file",
    ]);
  });

  it("keeps a removed line that looks like a header from being read as one", () => {
    const tricky =
      "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,1 @@\n keep\n-++ /dev/null\n";
    assert.equal(parseChangeset(annotateChangeset(tricky)).files.get("x.md")?.deleted, false);
  });

  it("parses to the same files and hunk ranges as the raw diff", () => {
    const raw = parseChangeset(OBSERVED);
    const fromAnnotated = parseChangeset(annotated);
    assert.deepEqual([...fromAnnotated.files.entries()], [...raw.files.entries()]);
  });

  describe("the gate on the observed review, with the token appended as the harness does", () => {
    const changeset = parseChangeset(`${annotated}\nreview-token: ${TOKEN}\n`);
    const context = {
      base: BASE,
      head: HEAD,
      token: changeset.token,
      files: changeset.files,
      criteria: [{ id: "AC1", text: "owner only" }],
      pathExists: () => true,
    };
    const observedReport = (axis, line) =>
      report(axis, {
        files: [...changeset.files.keys()].map((path) => ({ path, status: "reviewed", note: "" })),
        criteria: axis === "spec" ? [met("AC1")] : [],
        findings: [
          finding("CRITICAL", {
            kind: "security",
            file: DEFECT_FILE,
            line,
            title: "Signed-in users bypass hold ownership check",
          }),
        ],
      });
    const gate = (line) =>
      evaluate({
        standardsOutput: envelope(observedReport("standards", line)),
        specOutput: envelope(observedReport("spec", line)),
        blocking: BLOCKING,
        context,
      });

    it("still rejects the observed citation of changeset line 69 as INVALID", () => {
      const result = gate(69);
      assert.equal(result.verdict, "invalid");
      assert.match(result.report, /line 69 is not inside a hunk of .*hold-access\.ts/);
    });

    it("BLOCKS on the same CRITICAL finding cited at source line 27", () => {
      const result = gate(27);
      assert.equal(result.verdict, "blocked");
      assert.deepEqual(result.decision.errors, { standards: [], spec: [] });
      assert.equal(result.decision.blockers[0]?.severity, "CRITICAL");
    });
  });
});

describe("blocking policy", () => {
  it("parses a severity list", () => {
    assert.deepEqual(parseBlocking("CRITICAL, HIGH"), ["CRITICAL", "HIGH"]);
  });

  it("rejects unknown or empty severity lists", () => {
    assert.throws(() => parseBlocking("CRITICAL,SEVERE"), /--block must list severities/);
    assert.throws(() => parseBlocking(""), /--block must list severities/);
  });
});
