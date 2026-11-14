import { describe, expect, it } from "vitest";
import {
  boardColumns,
  debtCounts,
  eligibilityOf,
  executionStatus,
  formatDuration,
  pipelinesOf,
  prioritizedDebt,
  recentActivity,
  runDurationMs,
  severityDistribution,
  summarizeRun,
  ticketCounts,
} from "./present";
import { buildState, type DashboardState } from "./state";
import {
  debtEntry,
  MINUTE,
  NOW,
  register,
  run,
  runJson,
  sessionLine,
  snapshot,
  ticket,
  triagedLow,
} from "./testing/fixtures";

const OPTIONS = { staleAfterMs: 15 * MINUTE, failureLimit: 25 };
const build = (overrides: Parameters<typeof snapshot>[0]) =>
  buildState(snapshot(overrides), OPTIONS);

const byNumber = (state: DashboardState, number: string) => {
  const found = state.tickets?.find((t) => t.number === number);
  if (found === undefined) {
    throw new Error(`no ticket ${number}`);
  }
  return found;
};

const firstRun = (state: DashboardState) => {
  const [first] = state.runs;
  if (first === undefined) {
    throw new Error("no run");
  }
  return first;
};

const completed = (number: string, slug: string, runId: string) => {
  const file = ticket(number, slug, "done");
  return {
    ...file,
    text: `${file.text}\n\n**Completed:** 2026-11-13 by slice/${number}-${slug} (run ${runId})`,
  };
};

describe("ticket eligibility and counts", () => {
  it("calculates eligibility only for ready-for-agent and never changes the status", async () => {
    const state = await build({
      tickets: [
        ticket("01", "base", "in-progress"),
        ticket("02", "free", "ready-for-agent"),
        ticket("03", "after-base", "ready-for-agent", ["01"]),
        ticket("04", "owner", "ready-for-agent"),
        ticket("05", "held", "ready-for-agent"),
        ticket("06", "stuck", "blocked"),
        ticket("07", "shipped", "done"),
        ticket("08", "odd", "doing"),
      ],
      register: register(debtEntry("TD-001", triagedLow("05", "ticket 04"))),
    });
    expect(
      ["01", "02", "03", "05", "06"].map((n) => [n, eligibilityOf(byNumber(state, n))]),
    ).toEqual([
      ["01", "not-applicable"],
      ["02", "eligible"],
      ["03", "waiting-blockers"],
      ["05", "waiting-debt"],
      ["06", "not-applicable"],
    ]);
    expect(byNumber(state, "08").status).toBe("doing");
    expect(ticketCounts(state.tickets ?? [])).toEqual({
      eligible: 2,
      waiting: 2,
      eligibilityUnknown: 0,
      inProgress: 1,
      blocked: 1,
      readyForHuman: 0,
      done: 1,
      unrecognized: 1,
      total: 8,
    });
  });

  it("reports eligibility as unknown, not eligible, when the debt gate is unavailable", async () => {
    const state = await build({
      tickets: [ticket("02", "free", "ready-for-agent")],
      register: "not a register",
    });
    expect(eligibilityOf(byNumber(state, "02"))).toBe("unknown");
    expect(ticketCounts(state.tickets ?? []).eligibilityUnknown).toBe(1);
  });

  it("flags a debt entry that needs triage separately from one that only waits", async () => {
    const state = await build({
      tickets: [ticket("02", "a", "ready-for-agent")],
      register: register(
        debtEntry("TD-002", { Status: "OPEN", Severity: "MEDIUM", Triage: "pending" }),
      ),
    });
    expect(eligibilityOf(byNumber(state, "02"))).toBe("debt-triage");
  });
});

describe("board columns", () => {
  it("groups by the status line alone and gives unrecognized statuses their own column", async () => {
    const state = await build({
      tickets: [
        ticket("03", "c", "ready-for-agent"),
        ticket("01", "a", "ready-for-agent"),
        ticket("02", "b", "done"),
        ticket("04", "d", "wip"),
      ],
    });
    const columns = boardColumns(state.tickets ?? []);
    expect(columns.map((c) => [c.key, c.tickets.map((t) => t.number)])).toEqual([
      ["ready-for-agent", ["01", "03"]],
      ["in-progress", []],
      ["blocked", []],
      ["ready-for-human", []],
      ["done", ["02"]],
      ["unrecognized", ["04"]],
    ]);
  });

  it("omits the unrecognized column when every status is recognized", async () => {
    const state = await build({ tickets: [ticket("01", "a", "blocked")] });
    expect(boardColumns(state.tickets ?? []).map((c) => c.key)).not.toContain("unrecognized");
  });
});

describe("execution pipeline", () => {
  const stages = (state: DashboardState, runIndex = 0) => {
    const target = state.runs[runIndex];
    if (target === undefined) {
      throw new Error("no run");
    }
    return pipelinesOf(target, state).map((p) => [
      p.ticket,
      p.stages.map((s) => `${s.stage}:${s.state}`),
    ]);
  };

  it("maps session phases to stages and marks the running one active in a live run", async () => {
    const state = await build({
      tickets: [ticket("13", "hold", "in-progress")],
      runs: [
        run("20261113-114500", {
          runJson: runJson("20261113-114500", "active"),
          sessionRecords: [
            sessionLine("2026-11-13T11:45:00Z", "13 red#1", "ok", "2026-11-13T11:48:00Z"),
            sessionLine("2026-11-13T11:48:00Z", "13 green#1", "running"),
          ],
          lastActivity: NOW - MINUTE,
        }),
      ],
    });
    expect(stages(state)).toEqual([
      [
        "13",
        [
          "planning:unknown",
          "implementation:active",
          "testing:completed",
          "review:unknown",
          "merge:unknown",
        ],
      ],
    ]);
    const planning = pipelinesOf(firstRun(state), state)[0]?.stages[0];
    expect(planning?.note).toContain("not recorded");
  });

  it("shows a running session of a quiet run as stale, and a failed review as failed", async () => {
    const state = await build({
      tickets: [ticket("14", "x", "in-progress")],
      runs: [
        run("20261112-090000", {
          runJson: runJson("20261112-090000", "active"),
          sessionRecords: [
            sessionLine("2026-11-12T09:00:00Z", "14 green#1", "ok", "2026-11-12T09:10:00Z"),
            sessionLine("2026-11-12T09:10:00Z", "14 review-spec", "failed", "2026-11-12T09:20:00Z"),
            sessionLine("2026-11-12T09:20:00Z", "14 review-fix", "running"),
          ],
          lastActivity: NOW - 600 * MINUTE,
        }),
      ],
    });
    expect(stages(state)[0]?.[1]).toEqual([
      "planning:unknown",
      "implementation:completed",
      "testing:unknown",
      "review:stale",
      "merge:unknown",
    ]);
  });

  it("completes the merge stage only when the ticket's completion record names the run", async () => {
    const state = await build({
      tickets: [completed("15", "shipped", "20261111-090000"), ticket("16", "other", "done")],
      runs: [
        run("20261111-090000", {
          sessionsTsv: [
            "started\tlabel\tsession\tstatus\texit\tfinished",
            sessionLine("2026-11-11T09:00:00Z", "15 green#1", "ok", "2026-11-11T09:30:00Z"),
            sessionLine("2026-11-11T09:30:00Z", "16 green#1", "ok", "2026-11-11T09:40:00Z"),
          ].join("\n"),
        }),
      ],
    });
    const merge = stages(state).map(([number, list]) => [number, (list as string[]).at(-1)]);
    expect(merge).toEqual([
      ["15", "merge:completed"],
      ["16", "merge:unknown"],
    ]);
  });

  it("leaves a Lead session unmapped instead of guessing its stage", async () => {
    const state = await build({
      tickets: [ticket("56", "lead", "in-progress")],
      runs: [
        run("20261110-090000", {
          sessionRecords: [
            sessionLine("2026-11-10T09:00:00Z", "56 lead", "ok", "2026-11-10T10:00:00Z"),
          ],
        }),
      ],
    });
    const [pipeline] = pipelinesOf(firstRun(state), state);
    expect(pipeline?.unmapped.map((s) => s.label)).toEqual(["56 lead"]);
    expect(pipeline?.stages.every((s) => s.state === "unknown")).toBe(true);
  });
});

describe("execution status", () => {
  it("is idle without an active run, stale when active runs are quiet, live otherwise", async () => {
    const idle = await build({ runs: [run("20261111-090000")] });
    const stale = await build({
      runs: [
        run("20261112-090000", {
          runJson: runJson("20261112-090000", "active"),
          lastActivity: NOW - 600 * MINUTE,
        }),
      ],
    });
    const live = await build({
      runs: [
        run("20261113-114500", {
          runJson: runJson("20261113-114500", "active"),
          lastActivity: NOW - MINUTE,
        }),
      ],
    });
    expect([idle, stale, live].map((s) => executionStatus(s).kind)).toEqual([
      "idle",
      "stale",
      "live",
    ]);
  });
});

describe("run summaries", () => {
  it("measures duration from the first session to run.json's finish", async () => {
    const state = await build({
      runs: [
        run("20261111-090000", {
          runJson: runJson("20261111-090000", "failed", "2026-11-11T10:05:00Z"),
          sessionsTsv: [
            "started\tlabel\tsession\tstatus\texit\tfinished",
            sessionLine("2026-11-11T09:00:00Z", "15 green#1", "ok", "2026-11-11T09:30:00Z"),
          ].join("\n"),
        }),
      ],
    });
    const [target] = state.runs;
    expect(target && runDurationMs(target, NOW)).toBe(65 * MINUTE);
    expect(target && summarizeRun(target, state, NOW).outcome).toBe("failed");
  });

  it("has no duration without sessions, even when run.json carries times", async () => {
    const imported = JSON.stringify({
      run_id: "20261108-092532",
      status: "failed",
      started_at: "2026-11-08T09:25:32Z",
      finished_at: "2026-11-08T09:25:32Z",
    });
    const state = await build({
      runs: [run("20261111-090000"), run("20261108-092532", { runJson: imported })],
    });
    expect(state.runs.map((r) => runDurationMs(r, NOW))).toEqual([null, null]);
    expect(formatDuration(null)).toBe("unknown");
  });

  it("collects the blocking findings of rejecting reviews as rejection reasons", async () => {
    const decision = JSON.stringify({
      verdict: "blocked",
      blockers: [{ axis: "spec", severity: "HIGH", title: "AC3 not met" }],
      findings: [{ severity: "HIGH" }],
    });
    const state = await build({
      tickets: [ticket("12", "lock-timeout", "in-progress")],
      runs: [
        run("20261111-090000", {
          decisions: [{ name: "12-lock-timeout.review-1.decision.json", text: decision }],
        }),
      ],
    });
    const [target] = state.runs;
    expect(target && summarizeRun(target, state, NOW).rejections).toEqual([
      "12 [HIGH] spec: AC3 not met",
    ]);
  });

  it("formats durations compactly", () => {
    expect([45_000, 12 * MINUTE, 125 * MINUTE].map(formatDuration)).toEqual([
      "45s",
      "12m",
      "2h 05m",
    ]);
  });
});

describe("recent activity", () => {
  it("lists timed sessions and failures newest first", async () => {
    const state = await build({
      runs: [
        run("20261113-090000", {
          sessionRecords: [
            sessionLine("2026-11-13T09:00:00Z", "13 red#1", "ok", "2026-11-13T09:10:00Z"),
            sessionLine("2026-11-13T09:10:00Z", "13 green#1", "failed", "2026-11-13T09:20:00Z"),
          ],
        }),
      ],
    });
    expect(recentActivity(state, 10).map((item) => [item.title, item.tone])).toEqual([
      ["13 green#1 failed", "bad"],
      ["session failed", "bad"],
      ["13 red#1 ok", "ok"],
    ]);
  });
});

describe("technical debt presentation", () => {
  const entries = (state: DashboardState) => state.debt?.entries ?? [];

  it("counts by register status and distributes by severity", async () => {
    const state = await build({
      tickets: [ticket("02", "a", "done")],
      register: register(
        debtEntry("TD-001", { ...triagedLow("none", "ticket 02"), Status: "RESOLVED" }),
        debtEntry("TD-002", triagedLow("none", "ticket 02")),
        debtEntry("TD-003", { ...triagedLow("none", "ticket 02"), Severity: "HIGH" }),
      ),
    });
    expect(debtCounts(entries(state))).toEqual({ open: 0, planned: 2, resolved: 1, other: 0 });
    expect(severityDistribution(entries(state)).map((r) => [r.severity, r.total])).toEqual([
      ["CRITICAL", 0],
      ["HIGH", 1],
      ["MEDIUM", 0],
      ["LOW", 2],
    ]);
  });

  it("puts entries the gate cites against a ticket first, then by severity", async () => {
    const state = await build({
      tickets: [
        ticket("01", "x", "done"),
        ticket("02", "owner", "ready-for-agent"),
        ticket("03", "dependent", "ready-for-agent"),
      ],
      register: register(
        debtEntry("TD-001", { ...triagedLow("none", "ticket 02"), Severity: "HIGH" }),
        debtEntry("TD-002", triagedLow("03", "ticket 02")),
        debtEntry("TD-003", { ...triagedLow("none", "ticket 02"), Status: "RESOLVED" }),
      ),
    });
    const ranked = prioritizedDebt(entries(state), state.debt?.held ?? []);
    expect(ranked.map((r) => [r.entry.id, r.holding])).toEqual([
      ["TD-002", ["03"]],
      ["TD-001", []],
    ]);
  });
});
