import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkRegisterText,
  fingerprint,
  parseRegister,
  recordFindings,
  renderRegister,
  validateRegister,
} from "./ralph-debt.mjs";

const PREAMBLE = "# Technical Debt Register\n\nHand-written intro.\n\n";

const entry = (id, fields = {}, history = []) => ({
  id,
  title: `Entry ${id}`,
  fields: {
    Status: "OPEN",
    Severity: "MEDIUM",
    Source: "ticket 03",
    Evidence: "`.ralph/logs/run/03.review-2.standards.json`",
    Components: "`packages/db/src/seed.ts:53`",
    Problem: "Venue lookup is check-then-act.",
    Impact: "Duplicate venues.",
    Justification: "Non-blocking.",
    Remediation: "Unique key and upsert.",
    ...fields,
  },
  history,
});

const register = (...entries) => ({ preamble: PREAMBLE, entries, trailer: "\n" });

const finding = (overrides = {}) => ({
  severity: "MEDIUM",
  kind: "defect",
  file: "packages/booking/src/booking-service.ts",
  line: 386,
  rule: "consistency",
  title: "Order is priced from a different seat set",
  problem: "Priced by holdId.",
  impact: "Total can diverge.",
  recommendation: "Price the locked set.",
  debt: "",
  axis: "standards",
  ...overrides,
});

const SOURCE = {
  ticketLabel: "ticket 05 (`05-place-order`)",
  ref: "ticket 05 review-2",
  run: "20261030-135423",
  evidence: ".ralph/logs/20261030-135423/05-place-order.review-2",
  date: "2026-10-30",
  justification: "Non-blocking under the merge policy.",
};

const record = (reg, findings, extra = {}) =>
  recordFindings(reg, { findings, blocking: ["CRITICAL", "HIGH"], source: SOURCE, ...extra });

describe("register format", () => {
  it("round-trips: parse(render(x)) renders identically, preamble kept verbatim", () => {
    const text = renderRegister(register(entry("TD-002"), entry("TD-001", {}, ["2026-10-30: x"])));
    assert.ok(text.startsWith(PREAMBLE));
    assert.equal(renderRegister(parseRegister(text)), text);
    assert.deepEqual(
      parseRegister(text).entries.map((e) => e.id),
      ["TD-001", "TD-002"],
    );
    assert.deepEqual(checkRegisterText(text), []);
  });

  it("summarises entries per status and severity", () => {
    const planned = entry("TD-002", { Severity: "LOW", Status: "PLANNED", Target: "ticket 14" });
    const text = renderRegister(register(entry("TD-001"), planned));
    assert.match(text, /\| OPEN +\| 0 +\| 0 +\| 1 +\| 0 +\| 1 +\|/);
    assert.match(text, /\| PLANNED +\| 0 +\| 0 +\| 0 +\| 1 +\| 1 +\|/);
  });

  it("pads the summary table like Biome's Markdown formatter", () => {
    const text = renderRegister(register());
    assert.match(text, /\n\| Status {8}\| CRITICAL \| HIGH \| MEDIUM \| LOW \| Total \|\n/);
    assert.match(text, /\n\| -{13} \| -{8} \| -{4} \| -{6} \| -{3} \| -{5} \|\n/);
  });

  it("reports a hand edit that is not in canonical form", () => {
    const text = renderRegister(register(entry("TD-001"))).replace(
      /(\| OPEN +\| 0 +\| 0 +\| )1/,
      "$17",
    );
    assert.match(checkRegisterText(text).join("\n"), /not in canonical form/);
  });

  it("requires the generated-section markers", () => {
    assert.match(checkRegisterText("# Register\n").join("\n"), /ralph-debt:begin/);
  });
});

describe("register rules", () => {
  const errorsOf = (...entries) => validateRegister(register(...entries)).join("\n");

  it("refuses a RESOLVED entry without resolution and verification evidence", () => {
    assert.match(errorsOf(entry("TD-001", { Status: "RESOLVED" })), /needs a Resolution/);
    const claimed = entry("TD-001", {
      Status: "RESOLVED",
      Resolution: "fixed",
      Verification: "trust me",
    });
    assert.match(errorsOf(claimed), /Verification naming an existing test/);
  });

  it("refuses verification that names a test that does not exist", () => {
    const resolved = entry("TD-001", {
      Status: "RESOLVED",
      Resolution: "fixed",
      Verification: "`packages/db/src/nope.test.ts::venue is unique`",
    });
    assert.match(errorsOf(resolved), /Verification naming an existing test/);
  });

  it("accepts verification naming a test file that exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-debt-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "seed.test.ts"), "");
    const resolved = entry("TD-001", {
      Status: "RESOLVED",
      Resolution: "venues.name is unique; the seed upserts.",
      Verification: "`src/seed.test.ts::concurrent seeds create one venue`",
    });
    assert.deepEqual(validateRegister(register(resolved), { root }), []);
  });

  it("judges verification with an injected exists check instead of the file system", () => {
    const asked = [];
    const resolved = entry("TD-001", {
      Status: "RESOLVED",
      Resolution: "fixed",
      Verification: "`src/new.test.ts::a test the change adds`; `../outside.test.ts`",
    });
    const inTree = (path) => {
      asked.push(path);
      return path === "src/new.test.ts";
    };
    assert.deepEqual(validateRegister(register(resolved), { exists: inTree }), []);
    // Only the path part is asked about, and a path leaving the repository never is.
    assert.deepEqual(asked, ["src/new.test.ts"]);
    const elsewhere = validateRegister(register(resolved), { exists: () => false }).join("\n");
    assert.match(elsewhere, /Verification naming an existing test/);
  });

  it("refuses a deferral without justification and a plan without a target", () => {
    assert.match(errorsOf(entry("TD-001", { Justification: "none" })), /needs a Justification/);
    assert.match(errorsOf(entry("TD-001", { Status: "PLANNED" })), /needs a Target/);
  });

  it("refuses to leave an escalated entry OPEN or accepted", () => {
    assert.match(
      errorsOf(entry("TD-001", { Escalation: "may be HIGH: blocks seats forever" })),
      /escalated entry must be PLANNED/,
    );
    const planned = entry("TD-001", {
      Escalation: "may be HIGH",
      Status: "PLANNED",
      Target: "ticket 14",
    });
    assert.equal(errorsOf(planned), "");
  });

  it("refuses duplicate ids, unknown statuses and missing required fields", () => {
    const errors = errorsOf(entry("TD-001"), entry("TD-001", { Status: "DONE", Problem: "none" }));
    assert.match(errors, /duplicate id/);
    assert.match(errors, /Status must be one of/);
    assert.match(errors, /Problem is required/);
  });
});

describe("recording an approved review", () => {
  it("adds each deferred finding as an OPEN entry at its original severity", () => {
    const { register: after, errors } = record(register(entry("TD-001")), [finding()]);
    assert.deepEqual(errors, []);
    const added = after.entries.find((e) => e.id === "TD-002");
    assert.equal(added?.fields.Status, "OPEN");
    assert.equal(added?.fields.Severity, "MEDIUM");
    assert.equal(added?.fields.Components, "`packages/booking/src/booking-service.ts:386`");
    assert.equal(
      added?.fields.Evidence,
      "`.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`",
    );
    assert.deepEqual(validateRegister(after), []);
  });

  it("is idempotent: recording the same round twice changes nothing", () => {
    const findings = [finding(), finding({ axis: "spec", line: 12, title: "Other" })];
    const once = record(register(), findings);
    const twice = record(once.register, findings);
    assert.equal(renderRegister(twice.register), renderRegister(once.register));
  });

  it("merges the two axes' reports of one file and line into one entry", () => {
    const { register: after } = record(register(), [
      finding(),
      finding({ axis: "spec", severity: "LOW", title: "Price lines use another seat set" }),
    ]);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0]?.history.length, 2);
  });

  it("updates the entry a finding names in `debt` instead of duplicating it", () => {
    const { register: after } = record(register(entry("TD-001")), [
      finding({ debt: "TD-001", title: "Reworded by a later reviewer", file: "x.ts" }),
    ]);
    assert.equal(after.entries.length, 1);
    assert.match(after.entries[0]?.history[0] ?? "", /seen again: MEDIUM defect at `x.ts:386`/);
  });

  it("recognises a repeat of the same finding in a later ticket by its fingerprint", () => {
    const first = record(register(), [finding()]);
    const later = recordFindings(first.register, {
      findings: [finding({ line: 400 })],
      blocking: ["CRITICAL", "HIGH"],
      source: { ...SOURCE, ref: "ticket 06 review-1", run: "20261031-000000" },
    });
    assert.equal(later.register.entries.length, 1);
    assert.equal(later.register.entries[0]?.history.length, 2);
    assert.equal(fingerprint(finding()), fingerprint(finding({ line: 400 })));
  });

  it("notes a higher severity in the history but keeps the original severity", () => {
    const { register: after } = record(register(entry("TD-001", { Severity: "LOW" })), [
      finding({ debt: "TD-001" }),
    ]);
    assert.equal(after.entries[0]?.fields.Severity, "LOW");
    assert.match(after.entries[0]?.history.join("\n") ?? "", /higher severity than recorded/);
  });

  it("reopens a RESOLVED entry that is reported again", () => {
    const resolved = entry("TD-001", {
      Status: "RESOLVED",
      Resolution: "fixed in ticket 05",
      Verification: "`x.test.ts`",
    });
    const { register: after } = record(register(resolved), [finding({ debt: "TD-001" })]);
    assert.equal(after.entries[0]?.fields.Status, "OPEN");
    assert.match(
      after.entries[0]?.history[0] ?? "",
      /reopened.*previous resolution: fixed in ticket 05/,
    );
  });

  it("refuses to record a blocking finding or an unknown debt id", () => {
    assert.match(
      record(register(), [finding({ severity: "HIGH" })]).errors.join(),
      /blocking HIGH/,
    );
    assert.match(
      record(register(), [finding({ debt: "TD-009" })]).errors.join(),
      /unknown debt TD-009/,
    );
  });

  it("refuses a register that lost an entry of the base branch", () => {
    const { errors } = record(register(), [], { base: register(entry("TD-001")) });
    assert.match(errors.join(), /TD-001 exists on the base branch but was removed/);
  });

  it("attests a resolution made in the slice, once", () => {
    const base = register(entry("TD-001"));
    const resolved = register(
      entry("TD-001", { Status: "RESOLVED", Resolution: "fixed", Verification: "`x.test.ts`" }),
    );
    const once = record(resolved, [], { base });
    const twice = record(once.register, [], { base });
    assert.deepEqual(twice.register.entries[0]?.history, [
      "2026-10-30: resolution verified: quality gate green and independent review approved (ticket 05 review-2, run 20261030-135423)",
    ]);
  });
});
