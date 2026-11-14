import { describe, expect, it } from "vitest";
import {
  parseBatchState,
  parseDecision,
  parseLockOwner,
  parsePause,
  parseRunJson,
  parseSandboxVerdict,
  parseSessionLabel,
  parseSessionsTsv,
} from "./artifacts";

describe("parseSessionLabel", () => {
  it.each([
    ["12 red#1", { ticket: "12", phase: "red", attempt: 1 }],
    ["12 review-fix#2", { ticket: "12", phase: "review-fix", attempt: 2 }],
    ["12 review-spec", { ticket: "12", phase: "review-spec", attempt: null }],
    ["54 lead", { ticket: "54", phase: "lead", attempt: null }],
  ])("reads %s", (label, expected) => {
    expect(parseSessionLabel(label)).toEqual(expected);
  });

  it("keeps a label of another shape as the phase, with no ticket", () => {
    expect(parseSessionLabel("preflight probe")).toEqual({
      ticket: null,
      phase: "preflight probe",
      attempt: null,
    });
  });
});

describe("parseSessionsTsv", () => {
  it("reads the merged file with its header and a per-process record without one", () => {
    const merged = [
      "started\tlabel\tsession\tstatus\texit\tfinished",
      "2026-11-06T16:51:57Z\t12 review-spec\tabc\tok\t0\t2026-11-06T16:54:22Z",
      "2026-11-06T16:54:22Z\t12 review-fix#1\tdef\ttimed-out\t124\t2026-11-06T17:54:22Z",
    ].join("\n");
    const parsed = parseSessionsTsv(merged);
    expect(parsed.ok && parsed.value.map((s) => [s.phase, s.attempt, s.status])).toEqual([
      ["review-spec", null, "ok"],
      ["review-fix", 1, "timed-out"],
    ]);

    const running = parseSessionsTsv("2026-11-13T10:00:00Z\t13 green#2\tghi\trunning\t-\t-\n");
    expect(running.ok && running.value[0]).toMatchObject({
      ticket: "13",
      phase: "green",
      attempt: 2,
      status: "running",
      statusRecognized: true,
      finished: null,
    });
  });

  it("flags a status ralph-loop.sh does not write", () => {
    const parsed = parseSessionsTsv("2026-11-13T10:00:00Z\t13 red#1\tx\tweird\t0\t-");
    expect(parsed.ok && parsed.value[0]?.statusRecognized).toBe(false);
  });

  it("rejects a malformed line, naming it", () => {
    expect(parseSessionsTsv("started\tlabel\n2026\t13 red#1\tx")).toEqual({
      ok: false,
      reason: "line 2 has 3 columns, expected 6",
    });
  });
});

describe("parseRunJson", () => {
  it("reads run.json", () => {
    expect(
      parseRunJson(
        '{"run_id":"20261108-175232","status":"failed","started_at":"a","finished_at":"b"}',
      ),
    ).toEqual({
      ok: true,
      value: { runId: "20261108-175232", status: "failed", startedAt: "a", finishedAt: "b" },
    });
  });

  it("explains invalid JSON and wrong shapes instead of throwing", () => {
    const broken = parseRunJson("{");
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.reason).toMatch(/^invalid JSON/);
    expect(parseRunJson('{"run_id":"x"}')).toEqual({
      ok: false,
      reason: expect.stringContaining("`status`"),
    });
  });
});

describe("parseDecision", () => {
  it("counts findings by severity and evidence errors across axes", () => {
    const parsed = parseDecision(
      JSON.stringify({
        verdict: "blocked",
        blockers: [{ axis: "spec", severity: "HIGH", title: "AC12 is partial" }],
        findings: [{ severity: "MEDIUM" }, { severity: "LOW" }, { severity: "MEDIUM" }],
        errors: { standards: ["token mismatch"], spec: [] },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        verdict: "blocked",
        blockers: [{ axis: "spec", severity: "HIGH", title: "AC12 is partial" }],
        findings: { MEDIUM: 2, LOW: 1 },
        errors: 1,
      },
    });
  });
});

describe("parseSandboxVerdict", () => {
  it("reads exit, outcome and an optional reason", () => {
    expect(parseSandboxVerdict('{"exit":75,"outcome":"paused"}')).toEqual({
      ok: true,
      value: { exit: 75, outcome: "paused", reason: null },
    });
    expect(parseSandboxVerdict('{"exit":3,"outcome":"untrusted","reason":"TD-026"}')).toEqual({
      ok: true,
      value: { exit: 3, outcome: "untrusted", reason: "TD-026" },
    });
  });
});

describe("parseBatchState", () => {
  it("reads the batch, its stop and its tickets", () => {
    const parsed = parseBatchState(
      JSON.stringify({
        batch: "20261106153156",
        max_tickets: 1,
        status: "stopped",
        stop: { reason: "rejected", detail: "ticket 12 was rejected", at: "2026-11-06T18:09Z" },
        tickets: [{ number: "12", slug: "12-x", stage: "rejected", sha: null }],
        updated_at: "2026-11-06T18:09Z",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        batch: "20261106153156",
        status: "stopped",
        maxTickets: 1,
        stop: { reason: "rejected", detail: "ticket 12 was rejected", at: "2026-11-06T18:09Z" },
        tickets: [{ number: "12", slug: "12-x", stage: "rejected" }],
        updatedAt: "2026-11-06T18:09Z",
      },
    });
  });
});

describe("parseLockOwner", () => {
  it("leaves fields the owner file lacks unknown", () => {
    expect(parseLockOwner('{"pid":42}')).toEqual({
      ok: true,
      value: { pid: 42, host: null, startedAt: null },
    });
  });
});

describe("parsePause", () => {
  it("reads the key=value pause record", () => {
    const parsed = parsePause(
      [
        "ticket=12",
        "ref=ralph/paused/12-x",
        "phase=review",
        "attempt=1",
        "round=1",
        "reason=transient",
        "run=20261106-153256",
      ].join("\n"),
    );
    expect(parsed.ok && parsed.value).toMatchObject({ ticket: "12", phase: "review" });
  });

  it("names the keys a truncated record lacks", () => {
    expect(parsePause("ticket=12\nphase=green")).toEqual({
      ok: false,
      reason: "missing attempt, round, reason, run, ref",
    });
  });
});
