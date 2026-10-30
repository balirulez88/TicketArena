import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, parseBlocking } from "./ralph-review.mjs";

const BLOCKING = ["CRITICAL", "HIGH"];

const finding = (severity) => ({
  severity,
  file: "packages/booking/src/hold.ts",
  line: 42,
  rule: "docs/workflow/code-review.md: lock order",
  title: `${severity} finding`,
  problem: "Seats are locked before the hold.",
  impact: "Two buyers can deadlock.",
  recommendation: "Lock the hold first, then seats ORDER BY id.",
});

const report = (axis, findings = []) => ({
  axis,
  status: "reviewed",
  summary: `${axis} reviewed`,
  findings,
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

const run = (standards, spec) =>
  evaluate({ standardsOutput: standards, specOutput: spec, blocking: BLOCKING });

describe("ralph review gate", () => {
  it("approves when both axes report no findings", () => {
    const result = run(envelope(report("standards")), envelope(report("spec")));
    assert.equal(result.verdict, "approved");
    assert.equal(result.feedback, "");
  });

  it("approves with only non-blocking findings and still reports them", () => {
    const result = run(
      envelope(report("standards", [finding("MEDIUM"), finding("LOW")])),
      envelope(report("spec")),
    );
    assert.equal(result.verdict, "approved");
    assert.match(result.report, /\[MEDIUM\] MEDIUM finding/);
  });

  it("blocks on a HIGH finding in either axis", () => {
    const result = run(envelope(report("standards")), envelope(report("spec", [finding("HIGH")])));
    assert.equal(result.verdict, "blocked");
    assert.match(result.feedback, /\(spec axis\)/);
    assert.match(result.feedback, /Lock the hold first/);
  });

  it("blocks on a CRITICAL finding and hands only blocking findings to the fixer", () => {
    const result = run(
      envelope(report("standards", [finding("LOW"), finding("CRITICAL")])),
      envelope(report("spec")),
    );
    assert.equal(result.verdict, "blocked");
    assert.match(result.feedback, /\[CRITICAL\]/);
    assert.doesNotMatch(result.feedback, /\[LOW\]/);
  });

  it("keeps the two axes in separate report sections", () => {
    const result = run(
      envelope(report("standards", [finding("LOW")])),
      envelope(report("spec", [finding("HIGH")])),
    );
    const standards = result.report.indexOf("## Standards");
    const spec = result.report.indexOf("## Spec");
    assert.ok(standards > 0 && spec > standards);
    assert.ok(result.report.indexOf("[LOW]") < spec);
    assert.ok(result.report.indexOf("[HIGH]") > spec);
  });

  it("honours a stricter blocking policy", () => {
    const result = evaluate({
      standardsOutput: envelope(report("standards", [finding("MEDIUM")])),
      specOutput: envelope(report("spec")),
      blocking: parseBlocking("CRITICAL,HIGH,MEDIUM"),
    });
    assert.equal(result.verdict, "blocked");
  });

  describe("never approves a failed review", () => {
    const valid = envelope(report("spec"));
    const cases = {
      "missing output": "",
      "non-JSON output": "Looks good to me!",
      "agent error result": envelope(report("standards"), { is_error: true, subtype: "error" }),
      "max-turns result": envelope(report("standards"), { subtype: "error_max_turns" }),
      "no structured output": envelope(undefined),
      "wrong axis": envelope(report("spec")),
      "skipped axis": envelope({ ...report("standards"), status: "skipped" }),
      "missing summary": envelope({ ...report("standards"), summary: "" }),
      "unknown severity": envelope(
        report("standards", [{ ...finding("HIGH"), severity: "BLOCKER" }]),
      ),
      "finding without recommendation": envelope(
        report("standards", [{ ...finding("LOW"), recommendation: " " }]),
      ),
      "findings not a list": envelope({ ...report("standards"), findings: "none" }),
    };
    for (const [name, standardsOutput] of Object.entries(cases)) {
      it(name, () => {
        const result = run(standardsOutput, valid);
        assert.equal(result.verdict, "invalid");
        assert.match(result.report, /INVALID REPORT/);
        assert.equal(result.feedback, "");
      });
    }
  });

  describe("with a changeset token", () => {
    const TOKEN = "3f9a0c1d2e4b5a69";
    const withToken = (axis, changesetToken) =>
      envelope({ ...report(axis), changeset_token: changesetToken });
    const runWithToken = (standards, spec) =>
      evaluate({ standardsOutput: standards, specOutput: spec, blocking: BLOCKING, token: TOKEN });

    it("approves when both reviewers echo the token", () => {
      const result = runWithToken(withToken("standards", TOKEN), withToken("spec", TOKEN));
      assert.equal(result.verdict, "approved");
    });

    it("never approves a reviewer that did not read the changeset", () => {
      const missing = runWithToken(envelope(report("standards")), withToken("spec", TOKEN));
      const wrong = runWithToken(withToken("standards", TOKEN), withToken("spec", "guessed"));
      for (const result of [missing, wrong]) {
        assert.equal(result.verdict, "invalid");
        assert.match(result.report, /did not read the whole changeset/);
      }
    });

    it("does not let blocking findings hide an unread changeset", () => {
      const result = runWithToken(
        envelope({ ...report("standards", [finding("HIGH")]) }),
        withToken("spec", TOKEN),
      );
      assert.equal(result.verdict, "invalid");
    });
  });

  it("accepts a bare report from a non-Claude reviewer", () => {
    const result = run(JSON.stringify(report("standards")), JSON.stringify(report("spec")));
    assert.equal(result.verdict, "approved");
  });

  it("rejects an empty or unknown blocking policy", () => {
    assert.throws(() => parseBlocking(""), /--block/);
    assert.throws(() => parseBlocking("HIGH,SEVERE"), /--block/);
  });
});
