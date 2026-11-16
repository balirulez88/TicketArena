import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditErrors,
  checkRegisterText,
  debtGate,
  fingerprint,
  loadTickets,
  parseRegister,
  parseTicket,
  recordFindings,
  renderRegister,
  sliceErrors,
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
    assert.match(errorsOf(resolved), /nope\.test\.ts, which is not an existing test/);
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
    // Only the path part is asked about; a path leaving the repository never is, and is refused.
    assert.match(
      validateRegister(register(resolved), { exists: inTree }).join("\n"),
      /\.\.\/outside\.test\.ts, which is not an existing test/,
    );
    assert.deepEqual(asked, ["src/new.test.ts"]);
    const inside = entry("TD-001", { ...resolved.fields, Verification: "`src/new.test.ts::x`" });
    assert.deepEqual(validateRegister(register(inside), { exists: inTree }), []);
    const elsewhere = validateRegister(register(inside), { exists: () => false }).join("\n");
    assert.match(elsewhere, /src\/new\.test\.ts, which is not an existing test/);
  });

  it("refuses verification evidence that is not a test the gate runs", () => {
    const resolved = entry("TD-001", {
      Status: "RESOLVED",
      Resolution: "documented",
      Verification: "`docs/database/index.md`; `src/new.test.ts`",
    });
    const errors = validateRegister(register(resolved), { exists: () => true }).join("\n");
    assert.match(errors, /docs\/database\/index\.md, which is not a test file the gate runs/);
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

// --- The debt gate (ADR 0016) ------------------------------------------------------------------

const TODAY = "2026-11-06: triaged in a maintenance commit";
const triaged = (id, fields = {}, history = []) =>
  entry(id, { Severity: "LOW", Risk: "CORRECTNESS", Triage: TODAY, ...fields }, history);
const ticket = (number, blockedBy = [], status = "ready-for-agent") => ({
  number,
  blockedBy,
  status,
});
const tickets = (...list) => new Map(list.map((t) => [t.number, t]));
// 02 builds on 01; 03 builds on 02 (so on 01 too); 04 is independent; 01 is done.
const GRAPH = tickets(
  ticket("01", [], "done"),
  ticket("02", ["01"]),
  ticket("03", ["02"]),
  ticket("04"),
);
const verdicts = (...entries) =>
  Object.fromEntries([...debtGate(register(...entries), GRAPH)].map(([n, v]) => [n, v.state]));

describe("register format with the debt gate's fields", () => {
  it("gives an older register's entries the untriaged defaults on format (migration)", () => {
    const old = renderRegister(register(entry("TD-001"))).replace(
      /^- \*\*(Risk|Triage|Blocks|Acceptance):\*\*.*\n/gm,
      "",
    );
    assert.doesNotMatch(old, /\*\*Risk:\*\*/);
    // The old text is not canonical any more, and formatting adds the fields untriaged.
    assert.match(checkRegisterText(old).join("\n"), /not in canonical form/);
    const migrated = renderRegister(parseRegister(old));
    assert.match(migrated, /- \*\*Risk:\*\* UNTRIAGED\n- \*\*Triage:\*\* pending\n/);
    assert.match(migrated, /- \*\*Blocks:\*\* none\n- \*\*Acceptance:\*\* none\n/);
    assert.deepEqual(checkRegisterText(migrated), []);
  });

  it("keeps a RESOLVED entry's record and evidence intact through the migration", () => {
    const resolved = entry(
      "TD-001",
      {
        Status: "RESOLVED",
        Resolution: "venues.name is unique.",
        Verification: "`src/seed.test.ts::one venue`",
        Target: "ticket 41 (`issues/41-fixes.md`)",
      },
      ["2026-10-30: recorded", "2026-10-30: resolution verified"],
    );
    const old = renderRegister(register(resolved)).replace(
      /^- \*\*(Risk|Triage|Blocks|Acceptance):\*\*.*\n/gm,
      "",
    );
    const after = parseRegister(renderRegister(parseRegister(old))).entries[0];
    for (const [name, value] of Object.entries(resolved.fields)) {
      assert.equal(after?.fields[name], value, name);
    }
    assert.deepEqual(after?.history, resolved.history);
    // A finished ticket in a RESOLVED entry's Target is history, not something to reconcile.
    const done = tickets(ticket("41", [], "done"));
    assert.deepEqual(
      validateRegister(parseRegister(old), { exists: () => true, tickets: done }),
      [],
    );
  });

  it("counts entries per risk class and status", () => {
    const text = renderRegister(register(triaged("TD-001"), entry("TD-002")));
    assert.match(text, /\| CORRECTNESS +\| 1 +\| 0 +\| 0 +\| 0 +\| 0 +\| 1 +\|/);
    assert.match(text, /\| UNTRIAGED +\| 1 +\| 0 +\| 0 +\| 0 +\| 0 +\| 1 +\|/);
  });

  it("reads a ticket's number, status and blockers like ralph-loop.sh does", () => {
    const text =
      "# 17: Saga\n\n**Blocked by:** 08, 44 (payment latency 2s)\n\n**Status:** ready-for-agent\n";
    assert.deepEqual(parseTicket("17-saga.md", text), {
      number: "17",
      status: "ready-for-agent",
      blockedBy: ["08", "44"],
    });
    assert.deepEqual(
      parseTicket("43-x.md", "**Blocked by:** None (can start immediately)\n").blockedBy,
      [],
    );
  });

  it("judges an active ticket file over an archived copy with the same number", () => {
    // A ticket put back into issues/ while its archive exists must still get a verdict, so the
    // loop selects it and its own refusal to process an archived ticket again fires.
    const root = mkdtempSync(join(tmpdir(), "ralph-debt-"));
    mkdirSync(join(root, "issues", "done"), { recursive: true });
    writeFileSync(join(root, "issues", "done", "01-demo.md"), "**Status:** done\n");
    writeFileSync(join(root, "issues", "01-demo.md"), "**Status:** ready-for-agent\n");
    assert.equal(loadTickets(root).get("01")?.status, "ready-for-agent");
    assert.equal(debtGate(register(), loadTickets(root)).get("01")?.state, "clear");
  });
});

describe("triage rules", () => {
  const errorsOf = (...entries) => validateRegister(register(...entries)).join("\n");

  it("keeps the risk class apart from blocking: a class alone blocks nothing", () => {
    assert.equal(errorsOf(triaged("TD-001", { Risk: "SECURITY" })), "");
    assert.equal(verdicts(triaged("TD-001", { Risk: "SECURITY" }))["03"], "clear");
  });

  it("refuses a triaged entry without a class", () => {
    assert.match(errorsOf(triaged("TD-001", { Risk: "UNTRIAGED" })), /needs a Risk class/);
  });

  it("refuses blocking without an owner, or blocking the owner itself", () => {
    assert.match(errorsOf(triaged("TD-001", { Blocks: "03" })), /needs a Target ticket/);
    assert.match(
      errorsOf(triaged("TD-001", { Target: "ticket 03", Blocks: "03" })),
      /cannot block the ticket that owns its fix/,
    );
    assert.match(errorsOf(triaged("TD-001", { Blocks: "3, x" })), /two-digit ticket numbers/);
    assert.match(
      errorsOf(triaged("TD-001", { Target: "before deployment" })),
      /start with "ticket NN"/,
    );
  });

  it("requires every triaged unresolved MEDIUM finding to have an owning ticket", () => {
    assert.match(errorsOf(triaged("TD-001", { Severity: "MEDIUM" })), /needs a Target ticket/);
    const owned = triaged("TD-001", { Severity: "MEDIUM", Status: "PLANNED", Target: "ticket 04" });
    assert.equal(errorsOf(owned), "");
  });

  it("accepts a risk only as a triaged, justified human decision that blocks nothing", () => {
    const accepted = (fields) => triaged("TD-001", { Status: "ACCEPTED_RISK", ...fields });
    assert.match(errorsOf(accepted({})), /needs "Residual risk:" in Acceptance/);
    const full = {
      Acceptance:
        "Residual risk: hot aggregates drain slowly. Review when: a load test shows backlog. Decided by: the user, 2026-11-06.",
    };
    assert.equal(errorsOf(accepted(full)), "");
    assert.match(errorsOf(accepted({ ...full, Triage: "pending" })), /must be triaged/);
    assert.match(
      errorsOf(accepted({ ...full, Target: "ticket 04", Blocks: "03" })),
      /ACCEPTED_RISK entry cannot block/,
    );
    assert.match(errorsOf(triaged("TD-002", full)), /Acceptance belongs to an ACCEPTED_RISK/);
  });
});

describe("ticket references", () => {
  const errorsWith = (graph, ...entries) =>
    validateRegister(register(...entries), { tickets: graph }).join("\n");

  it("refuses unresolved debt owned by or blocking a ticket that is missing or done", () => {
    assert.match(
      errorsWith(GRAPH, triaged("TD-001", { Target: "ticket 99" })),
      /ticket 99, which does not exist/,
    );
    assert.match(
      errorsWith(GRAPH, triaged("TD-001", { Status: "PLANNED", Target: "ticket 01" })),
      /Target ticket 01 is done but the entry is still PLANNED: reconcile it/,
    );
    assert.match(
      errorsWith(GRAPH, triaged("TD-001", { Target: "ticket 04", Blocks: "01" })),
      /Blocks names ticket 01, which is done: reconcile it/,
    );
  });

  it("refuses a dependency cycle made of blockers and debt", () => {
    // 03 builds on 02; debt owned by 03 that blocks 02 means neither can ever start.
    const cycle = triaged("TD-001", { Target: "ticket 03", Blocks: "02" });
    assert.match(errorsWith(GRAPH, cycle), /cycle: 0[23] -> 0[23] -> 0[23]/);
    assert.equal(errorsWith(GRAPH, triaged("TD-001", { Target: "ticket 04", Blocks: "03" })), "");
  });
});

describe("the debt gate", () => {
  it("lets every ticket start when all unresolved debt is triaged and blocks nothing", () => {
    assert.deepEqual(verdicts(triaged("TD-001"), triaged("TD-002", { Risk: "VERIFICATION" })), {
      "02": "clear",
      "03": "clear",
      "04": "clear",
    });
  });

  it("holds an untriaged LOW finding against the tickets that build on its source only", () => {
    const fresh = entry("TD-001", { Severity: "LOW", Source: "ticket 02 (`02-two`)" });
    // 03 builds on 02, where it was found; 04 is independent and 02 itself is unaffected.
    assert.deepEqual(verdicts(fresh), { "02": "clear", "03": "needs-triage", "04": "clear" });
    const reasons = debtGate(register(fresh), GRAPH).get("03")?.reasons.join();
    assert.match(reasons ?? "", /TD-001 is untriaged and ticket 03 builds on ticket 02/);
  });

  it("follows the blockers transitively, through finished tickets", () => {
    const fromDone = entry("TD-001", { Severity: "LOW", Source: "ticket 01 (`01-one`)" });
    assert.deepEqual(verdicts(fromDone), {
      "02": "needs-triage",
      "03": "needs-triage",
      "04": "clear",
    });
  });

  it("holds an untriaged finding whose source is not a ticket against every ticket", () => {
    const preflight = entry("TD-001", { Severity: "LOW", Source: "harness preflight" });
    assert.deepEqual(verdicts(preflight), {
      "02": "needs-triage",
      "03": "needs-triage",
      "04": "needs-triage",
    });
  });

  it("stops every ticket while a MEDIUM finding is untriaged or unowned", () => {
    const untriaged = entry("TD-001", { Source: "ticket 02 (`02-two`)" });
    assert.deepEqual(new Set(Object.values(verdicts(untriaged))), new Set(["needs-triage"]));
    // Unowned: triaged but no Target. The static check refuses this too; the gate fails closed.
    const unowned = triaged("TD-001", { Severity: "MEDIUM" });
    assert.deepEqual(new Set(Object.values(verdicts(unowned))), new Set(["needs-triage"]));
    const owned = triaged("TD-001", { Severity: "MEDIUM", Status: "PLANNED", Target: "ticket 04" });
    assert.deepEqual(new Set(Object.values(verdicts(owned))), new Set(["clear"]));
  });

  it("makes a blocked ticket wait for the owner, and nothing else", () => {
    const blocking = triaged("TD-001", { Status: "PLANNED", Target: "ticket 04", Blocks: "03" });
    assert.deepEqual(verdicts(blocking), { "02": "clear", "03": "waiting", "04": "clear" });
    assert.match(
      debtGate(register(blocking), GRAPH).get("03")?.reasons.join() ?? "",
      /TD-001 \(CORRECTNESS\) until ticket 04 resolves it/,
    );
    // Resolved or accepted debt holds nothing up.
    for (const status of ["RESOLVED", "ACCEPTED_RISK"]) {
      const done = { ...blocking, fields: { ...blocking.fields, Status: status } };
      assert.equal(verdicts(done)["03"], "clear");
    }
  });

  it("puts triage first: a ticket both waiting and affected by untriaged risk needs triage", () => {
    const blocking = triaged("TD-001", { Status: "PLANNED", Target: "ticket 04", Blocks: "03" });
    const fresh = entry("TD-002", { Severity: "LOW", Source: "ticket 02 (`02-two`)" });
    assert.equal(verdicts(blocking, fresh)["03"], "needs-triage");
  });
});

// --- The global hold (ADR 0020) ----------------------------------------------------------------

describe("the global hold (ADR 0020)", () => {
  // 05 is worked by hand and owns the fix; 06 is blocked, 07 has a misspelt status.
  const HELD = tickets(
    ...GRAPH.values(),
    ticket("05", [], "ready-for-human"),
    ticket("06", [], "blocked"),
    ticket("07", [], "ready-for-agnet"),
  );
  const hold = (fields = {}) =>
    triaged("TD-001", {
      Severity: "MEDIUM",
      Risk: "SECURITY",
      Status: "PLANNED",
      Target: "ticket 05",
      Blocks: "ALL_AGENT_TICKETS",
      ...fields,
    });
  const states = (graph, ...entries) =>
    Object.fromEntries([...debtGate(register(...entries), graph)].map(([n, v]) => [n, v.state]));
  const errorsWith = (graph, ...entries) =>
    validateRegister(register(...entries), { tickets: graph }).join("\n");

  it("holds every unfinished ticket not worked by hand, whatever its status", () => {
    assert.deepEqual(states(HELD, hold()), {
      "02": "waiting",
      "03": "waiting",
      "04": "waiting",
      "05": "clear",
      "06": "waiting",
      "07": "waiting",
    });
    assert.match(
      debtGate(register(hold()), HELD).get("04")?.reasons.join() ?? "",
      /TD-001 \(SECURITY\) holds every ticket not ready-for-human until ticket 05 resolves it/,
    );
    assert.equal(errorsWith(HELD, hold()), "");
  });

  it("holds a ticket created after the entry was written, without listing it", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-debt-hold-"));
    mkdirSync(join(root, "issues"), { recursive: true });
    const write = (name, status) =>
      writeFileSync(
        join(root, "issues", name),
        `# x\n\n**Blocked by:** None\n\n**Status:** ${status}\n`,
      );
    write("05-fix.md", "ready-for-human");
    write("02-old.md", "ready-for-agent");
    const reg = register(hold());
    assert.equal(debtGate(reg, loadTickets(root)).get("02")?.state, "waiting");
    write("08-new.md", "ready-for-agent");
    assert.equal(debtGate(reg, loadTickets(root)).get("08")?.state, "waiting");
    assert.equal(debtGate(reg, loadTickets(root)).get("05")?.state, "clear");
  });

  it("releases every ticket once the entry is resolved, and only then", () => {
    for (const status of ["OPEN", "PLANNED", "IN_PROGRESS"]) {
      assert.equal(states(HELD, hold({ Status: status }))["04"], "waiting", status);
    }
    const resolved = hold({ Status: "RESOLVED", Resolution: "fixed", Verification: "none" });
    assert.equal(states(HELD, resolved)["04"], "clear");
  });

  it("needs triage everywhere it holds when the entry is sent back to triage", () => {
    const back = hold({ Triage: "pending", Severity: "LOW" });
    assert.equal(states(HELD, back)["04"], "needs-triage");
    assert.match(
      debtGate(register(back), HELD).get("04")?.reasons.join() ?? "",
      /TD-001 blocks ticket 04 and is back in triage/,
    );
  });

  it("keeps explicit blockers working next to it", () => {
    const explicit = triaged("TD-002", { Status: "PLANNED", Target: "ticket 04", Blocks: "03" });
    assert.deepEqual(states(GRAPH, explicit), { "02": "clear", "03": "waiting", "04": "clear" });
    const both = debtGate(register(hold(), explicit), HELD).get("03")?.reasons ?? [];
    assert.equal(both.length, 2);
  });

  it("refuses a malformed, mixed, unowned or self-holding global hold", () => {
    for (const value of ["ALL_AGENT_TICKETS, 03", "all_agent_tickets", "ALL", "*"]) {
      assert.match(errorsWith(HELD, hold({ Blocks: value })), /ALL_AGENT_TICKETS alone/, value);
    }
    assert.match(errorsWith(HELD, hold({ Target: "none" })), /needs a Target ticket/);
    assert.match(
      errorsWith(HELD, hold({ Target: "ticket 04" })),
      /needs an owner worked by hand: ticket 04 is ready-for-agent/,
    );
    const accepted = hold({
      Status: "ACCEPTED_RISK",
      Acceptance: "Residual risk: x. Review when: y. Decided by: z.",
    });
    assert.match(errorsWith(HELD, accepted), /ACCEPTED_RISK entry cannot block/);
  });

  it("refuses a hold whose owner builds on a ticket the hold stops (a deadlock)", () => {
    const graph = tickets(...HELD.values(), ticket("05", ["04"], "ready-for-human"));
    assert.match(errorsWith(graph, hold()), /cycle: .*05 -> 04|cycle: .*04 -> 05/);
  });

  it("fails closed on a Blocks value it cannot read, even without validation", () => {
    const result = states(HELD, hold({ Blocks: "everything" }));
    assert.deepEqual(new Set(Object.values(result)), new Set(["needs-triage"]));
    assert.match(
      debtGate(register(hold({ Blocks: "everything" })), HELD)
        .get("05")
        ?.reasons.join() ?? "",
      /TD-001 has a Blocks value the gate cannot read/,
    );
  });
});

describe("the gate CLI fails closed", () => {
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("ralph-debt.mjs", import.meta.url)), ...args],
      {
        encoding: "utf8",
      },
    );
  const fixture = (blocks) => {
    const root = mkdtempSync(join(tmpdir(), "ralph-debt-cli-"));
    mkdirSync(join(root, "issues"), { recursive: true });
    writeFileSync(
      join(root, "issues", "05-fix.md"),
      "# 05: Fix\n\n**Blocked by:** None\n\n**Status:** ready-for-human\n",
    );
    writeFileSync(
      join(root, "issues", "02-two.md"),
      "# 02: Two\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n",
    );
    const path = join(root, "register.md");
    const held = triaged("TD-001", {
      Severity: "MEDIUM",
      Status: "PLANNED",
      Target: "ticket 05",
      Blocks: blocks,
    });
    writeFileSync(path, renderRegister(register(held)));
    return { root, path };
  };

  it("prints the hold's verdict for every ticket from a valid register", () => {
    const { root, path } = fixture("ALL_AGENT_TICKETS");
    const result = cli("gate", path, "--root", root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^02\twaiting\tTD-001/m);
    assert.match(result.stdout, /^05\tclear\t/m);
  });

  it("prints no verdict at all for a missing, unreadable or invalid register", () => {
    const { root, path } = fixture("ALL_AGENT_TICKETS, 02");
    for (const target of [path, join(root, "missing.md"), root]) {
      const result = cli("gate", target, "--root", root);
      assert.notEqual(result.status, 0, target);
      assert.equal(result.stdout, "", target);
    }
  });
});

// The transition from TD-059's explicit list to the global hold must never leave a gap: while
// TD-059 is unresolved, the repository's own gate clears no ticket Ralph can select.
describe("the repository's safety hold (TD-059)", () => {
  it("clears no ready-for-agent ticket while TD-059 is unresolved", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const reg = parseRegister(readFileSync(join(root, "docs", "technical-debt.md"), "utf8"));
    const td059 = reg.entries.find((candidate) => candidate.id === "TD-059");
    assert.ok(td059, "TD-059 is in the register");
    if (td059.fields.Status === "RESOLVED") {
      return;
    }
    const all = loadTickets(root);
    const cleared = [...debtGate(reg, all)]
      .filter(([number]) => all.get(number)?.status === "ready-for-agent")
      .filter(([, verdict]) => verdict.state === "clear")
      .map(([number]) => number);
    assert.deepEqual(cleared, []);
  });
});

describe("what a slice may change in the register", () => {
  const base = register(
    triaged("TD-001", { Status: "PLANNED", Target: "ticket 04", Blocks: "03" }, [
      "2026-11-01: recorded",
    ]),
    triaged("TD-002", { Risk: "MAINTAINABILITY" }, ["2026-11-01: recorded"]),
  );
  const changed = (id, fields, history) =>
    register(
      ...base.entries.map((e) =>
        e.id === id
          ? { ...e, fields: { ...e.fields, ...fields }, history: history ?? e.history }
          : e,
      ),
    );
  const errorsOf = (next, ticketNumber = "02") =>
    sliceErrors(base, next, { ticket: ticketNumber }).join("\n");

  it("lets a slice change nothing, or resolve an entry with evidence", () => {
    assert.equal(errorsOf(base), "");
    const resolved = changed("TD-002", {
      Status: "RESOLVED",
      Resolution: "fixed",
      Verification: "`src/x.test.ts::works`",
    });
    assert.equal(errorsOf(resolved), "");
  });

  for (const [name, value] of [
    ["Severity", "MEDIUM"],
    ["Risk", "SECURITY"],
    ["Target", "ticket 03"],
    ["Blocks", "02"],
    ["Escalation", "worse than it looks"],
    ["Problem", "not a problem after all"],
    ["Remediation", "nothing to do"],
    ["Justification", "never mind"],
  ]) {
    it(`refuses a slice that changes ${name}`, () => {
      assert.match(
        errorsOf(changed("TD-001", { [name]: value })),
        new RegExp(`TD-001: ${name} changed`),
      );
    });
  }

  it("refuses a slice that triages, accepts or re-plans an entry", () => {
    assert.match(
      errorsOf(changed("TD-002", { Triage: "2026-11-07: the agent says it is fine" })),
      /Triage changed; only a human triages/,
    );
    assert.match(
      errorsOf(
        changed("TD-002", {
          Status: "ACCEPTED_RISK",
          Acceptance: "Residual risk: x. Review when: y. Decided by: the agent.",
        }),
      ),
      /Status OPEN -> ACCEPTED_RISK is a triage decision/,
    );
    assert.match(errorsOf(changed("TD-001", { Status: "OPEN" })), /Status PLANNED -> OPEN/);
  });

  it("refuses a slice that removes an entry, rewrites history or changes the rules", () => {
    assert.match(
      errorsOf(register(base.entries[0])),
      /TD-002 exists on the base branch but was removed/,
    );
    assert.match(
      errorsOf(changed("TD-001", {}, [])),
      /TD-001: history lines were changed or removed/,
    );
    const rules = { ...base, preamble: `${base.preamble}Slices may set ACCEPTED_RISK.\n` };
    assert.match(errorsOf(rules), /rules outside the generated section changed/);
  });

  it("refuses a new entry that arrives triaged, planned, blocking or resolved", () => {
    const sneaky = triaged("TD-003", { Target: "ticket 04", Blocks: "03" });
    const errors = errorsOf(register(...base.entries, sneaky));
    assert.match(errors, /TD-003: a new entry must have Triage pending/);
    assert.match(errors, /TD-003: a new entry must have Blocks none/);
    assert.equal(errorsOf(register(...base.entries, entry("TD-003", { Severity: "LOW" }))), "");
    const reused = register(base.entries[1], entry("TD-001", { Severity: "LOW" }));
    assert.match(
      sliceErrors(register(base.entries[1]), reused, { ticket: "02" }).join(),
      /TD-001: a new entry must take an id above every existing one/,
    );
  });

  it("requires the ticket to resolve every entry it owns before it merges", () => {
    // TD-001 is owned by ticket 04.
    assert.match(
      errorsOf(base, "04"),
      /TD-001 is owned by ticket 04 \(Target\) and must be RESOLVED, with a Verification test/,
    );
    const resolved = changed("TD-001", {
      Status: "RESOLVED",
      Resolution: "fixed",
      Verification: "`src/x.test.ts`",
    });
    assert.equal(errorsOf(resolved, "04"), "");
  });

  it("accepts exactly the recorder's own changes: new entries, sightings and reopening", () => {
    const resolvedBase = register(
      triaged(
        "TD-001",
        {
          Status: "RESOLVED",
          Target: "ticket 01",
          Resolution: "fixed",
          Verification: "`x.test.ts`",
        },
        ["2026-11-01: recorded"],
      ),
      triaged("TD-002", {}, ["2026-11-01: recorded"]),
    );
    const { register: next, errors } = record(resolvedBase, [
      finding({ debt: "TD-001", severity: "LOW" }),
      finding({ debt: "TD-002", severity: "MEDIUM" }),
      finding({ file: "new.ts", title: "A new one", severity: "LOW" }),
    ]);
    assert.deepEqual(errors, []);
    assert.equal(sliceErrors(resolvedBase, next, { ticket: "05" }).join("\n"), "");
    const [reopened, sighted, added] = next.entries;
    assert.equal(reopened?.fields.Status, "OPEN");
    assert.equal(reopened?.fields.Triage, "pending");
    assert.equal(reopened?.fields.Target, "none");
    assert.equal(sighted?.fields.Triage, "pending");
    assert.equal(sighted?.fields.Severity, "LOW");
    assert.equal(added?.fields.Triage, "pending");
  });
});

describe("recording keeps triage a human decision", () => {
  it("records a new finding untriaged, with the kind's class only as a suggestion", () => {
    const { register: after } = record(register(), [finding({ kind: "missing_test" })]);
    const added = after.entries[0];
    assert.equal(added?.fields.Risk, "UNTRIAGED");
    assert.equal(added?.fields.Triage, "pending");
    assert.match(added?.history[0] ?? "", /suggested risk VERIFICATION, awaiting triage/);
  });

  it("classifies a security finding as SECURITY, still awaiting triage", () => {
    const { register: after } = record(register(), [
      finding({ kind: "security", severity: "LOW" }),
    ]);
    assert.equal(after.entries[0]?.fields.Risk, "SECURITY");
    assert.equal(after.entries[0]?.fields.Triage, "pending");
  });

  it("keeps a triaged entry's decision on a sighting at the same or a lower severity", () => {
    const known = triaged("TD-001", { Severity: "MEDIUM", Status: "PLANNED", Target: "ticket 04" });
    const { register: after } = record(register(known), [
      finding({ debt: "TD-001", severity: "LOW" }),
    ]);
    assert.equal(after.entries[0]?.fields.Triage, TODAY);
  });

  it("sends a triaged entry back to triage when it is seen at a higher severity", () => {
    const { register: after } = record(register(triaged("TD-001")), [finding({ debt: "TD-001" })]);
    assert.equal(after.entries[0]?.fields.Triage, "pending");
    assert.match(
      after.entries[0]?.history[0] ?? "",
      /higher severity than recorded.*back to triage/,
    );
  });

  it("keeps what a blocking entry blocks when it is sent back to triage, and holds those tickets", () => {
    const blocking = triaged("TD-001", { Status: "PLANNED", Target: "ticket 04", Blocks: "30" });
    const before = register(blocking);
    const { register: after, errors } = record(before, [finding({ debt: "TD-001" })]);
    assert.deepEqual(errors, []);
    assert.equal(after.entries[0]?.fields.Triage, "pending");
    assert.equal(after.entries[0]?.fields.Blocks, "30");
    assert.deepEqual(validateRegister(after), []);
    // What the recorder did is a change a slice may carry.
    assert.deepEqual(sliceErrors(before, after, { ticket: "09" }), []);
    const tickets = new Map([
      ["04", { number: "04", status: "ready-for-agent", blockedBy: [] }],
      ["30", { number: "30", status: "ready-for-agent", blockedBy: [] }],
    ]);
    const verdict = debtGate(after, tickets).get("30");
    assert.equal(verdict?.state, "needs-triage");
    assert.match(
      verdict?.reasons.join("\n") ?? "",
      /TD-001 blocks ticket 30 and is back in triage/,
    );
  });

  it("reopens an accepted risk that is seen at a higher severity", () => {
    const accepted = triaged("TD-001", {
      Status: "ACCEPTED_RISK",
      Acceptance: "Residual risk: a. Review when: b. Decided by: c.",
    });
    const { register: after, errors } = record(register(accepted), [finding({ debt: "TD-001" })]);
    assert.deepEqual(errors, []);
    assert.equal(after.entries[0]?.fields.Status, "OPEN");
    assert.equal(after.entries[0]?.fields.Acceptance, "none");
    assert.deepEqual(validateRegister(after), []);
  });
});

describe("a maintainer's triage is auditable", () => {
  const base = register(triaged("TD-001", {}, ["2026-11-01: recorded"]));

  it("accepts a triage change that comes with a history line", () => {
    const next = register(
      triaged("TD-001", { Risk: "VERIFICATION", Target: "ticket 04", Status: "PLANNED" }, [
        "2026-11-01: recorded",
        "2026-11-06: triaged: VERIFICATION, owned by ticket 04 (maintenance commit)",
      ]),
    );
    assert.deepEqual(auditErrors(base, next), []);
  });

  it("refuses a triage change without one, and a lost entry or history line", () => {
    const silent = register(triaged("TD-001", { Risk: "VERIFICATION" }, ["2026-11-01: recorded"]));
    assert.match(
      auditErrors(base, silent).join(),
      /TD-001: Risk changed without a new history line/,
    );
    assert.match(auditErrors(base, register()).join(), /TD-001 was removed/);
    const rewritten = register(triaged("TD-001", {}, ["2026-11-01: never mind"]));
    assert.match(auditErrors(base, rewritten).join(), /history lines were changed or removed/);
  });

  it("does not count a field the older format did not have as a change", () => {
    const old = parseRegister(
      renderRegister(register(entry("TD-001", {}, ["2026-11-01: recorded"]))).replace(
        /^- \*\*(Risk|Triage|Blocks|Acceptance):\*\*.*\n/gm,
        "",
      ),
    );
    const migrated = register(
      triaged("TD-001", { Severity: "MEDIUM", Status: "PLANNED", Target: "ticket 04" }, [
        "2026-11-01: recorded",
      ]),
    );
    // Status and Target changed (they existed before): a history line is required for those.
    assert.match(auditErrors(old, migrated).join(), /TD-001: Status, Target changed/);
    const onlyNewFields = register(
      triaged("TD-001", { Severity: "MEDIUM" }, ["2026-11-01: recorded"]),
    );
    assert.deepEqual(auditErrors(old, onlyNewFields), []);
  });
});
