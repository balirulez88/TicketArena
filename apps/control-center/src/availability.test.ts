import { describe, expect, it } from "vitest";
import { executionStatus } from "./present";
import { renderPage } from "./render";
import type { FileText } from "./snapshot";
import { buildState } from "./state";
import {
  MINUTE,
  run,
  runJson,
  SESSIONS_HEADER,
  sessionLine,
  snapshot,
  ticket,
} from "./testing/fixtures";

// A source that could not be read must stay "unavailable" all the way to the page. An empty list
// is a claim ("nothing happened"); a failed read is not, and the page must never turn one into the
// other. Each case below was observed on the page as a confirmed zero, none, Idle or Quiet.

const OPTIONS = { staleAfterMs: 15 * MINUTE, failureLimit: 25 };
const NO_RALPH = "no .ralph/ in this checkout (Ralph writes it only where it runs)";
const everythingUnder = (reason: string) => ({
  runs: [reason],
  hostReviews: [reason],
  pauses: [reason],
  lock: [reason],
});
const page = async (overrides: Parameters<typeof snapshot>[0]) => {
  const state = await buildState(snapshot(overrides), OPTIONS);
  return { state, html: renderPage(state, { refreshSeconds: 0 }) };
};

describe("missing .ralph/ directory", () => {
  it("leaves runs, the lock and pauses unknown instead of empty", async () => {
    const { state } = await page({ incomplete: everythingUnder(NO_RALPH) });
    expect(state.runsIncomplete).toBe(NO_RALPH);
    expect(executionStatus(state).kind).toBe("unknown");
    expect(state.current.lock.held).toBeNull();
    expect(state.current.pausesIncomplete).toBe(NO_RALPH);
    expect(state.failuresIncomplete).toContain(NO_RALPH);
  });

  it("never says Idle, No runs, 0 succeeded, Quiet or not held", async () => {
    const { html } = await page({ incomplete: everythingUnder(NO_RALPH) });
    for (const claim of [
      "No run is active",
      ">Idle<",
      "No runs on record",
      "Nothing on record",
      "0 succeeded",
      "0 failed",
      ">Quiet<",
      "not held",
      'title="runs on record">0<',
    ]) {
      expect(html).not.toContain(claim);
    }
    expect(html).toContain("Run state unknown");
    expect(html).toContain(NO_RALPH);
  });
});

describe("unreadable Git branches", () => {
  it("leaves parked branches unknown and marks the failure list incomplete", async () => {
    const { state, html } = await page({ branches: null });
    expect(state.current.pausedBranches).toBeNull();
    expect(state.failuresIncomplete).toEqual(expect.stringContaining("git branches"));
    expect(html).not.toMatch(/Parked branches<\/dt><dd><span class="muted">none/);
  });
});

describe("unparseable session records", () => {
  it("marks the run's sessions incomplete instead of reporting zero sessions", async () => {
    const { state, html } = await page({
      runs: [
        run("20261110-100000", {
          runJson: runJson("20261110-100000", "failed"),
          sessionsTsv: "not\ta\tsessions file",
        }),
      ],
    });
    expect(state.runs[0]?.sessionsIncomplete).toEqual(expect.any(String));
    expect(html).not.toContain(">0 sessions<");
    expect(html).not.toContain("No session records in this run");
    expect(html).toContain("session records unavailable");
  });

  it("treats an unreadable per-process record like an unparseable one", async () => {
    const { state } = await page({
      runs: [
        run("20261110-100000", {
          runJson: runJson("20261110-100000", "active"),
          sessionRecords: [
            sessionLine("2026-11-10T10:00:00Z", "15 red#1", "ok", "2026-11-10T10:05:00Z"),
            { unreadable: "EACCES: permission denied" },
          ],
        }),
      ],
    });
    expect(state.runs[0]?.sessions).toHaveLength(1);
    expect(state.runs[0]?.sessionsIncomplete).toContain("EACCES");
  });
});

describe("unreadable review decisions", () => {
  it("does not report 'no reviews' for a run whose decision file is malformed", async () => {
    const { state, html } = await page({
      tickets: [ticket("15", "x", "in-progress")],
      runs: [
        run("20261110-100000", {
          sessionsTsv: [
            SESSIONS_HEADER,
            sessionLine("2026-11-10T10:00:00Z", "15 review-spec#1", "ok", "2026-11-10T10:05:00Z"),
          ].join("\n"),
          decisions: [{ name: "15-x.review-1.decision.json", text: "{broken" }],
        }),
      ],
    });
    expect(state.reviewGaps).toEqual([
      { kind: "loop", run: "20261110-100000", slug: "15-x", reason: expect.any(String) },
    ]);
    expect(html).not.toContain("no reviews");
    expect(html).toContain("reviews unavailable");
    expect(html).not.toMatch(/Loop review<\/dt><dd><span class="muted">none on record/);
  });

  it("records a host-review folder without decision.json as a gap, not as no review", async () => {
    const { state, html } = await page({
      tickets: [ticket("16", "y", "in-progress")],
      hostReviews: [{ run: "20261110-120000-1", slug: "16-y", text: null }],
    });
    expect(state.gaps).toContainEqual({
      source: "host review 20261110-120000-1/16-y",
      reason: "no decision.json (review still running, or it stopped before deciding)",
    });
    expect(state.reviewGaps).toEqual([
      { kind: "host", run: "20261110-120000-1", slug: "16-y", reason: expect.any(String) },
    ]);
    expect(html).not.toMatch(/Host review<\/dt><dd><span class="muted">none on record/);
  });
});

describe("unresolved ref", () => {
  it("calls the commit unresolved, not missing: Git may have failed for another reason", async () => {
    const { html } = await page({
      commit: null,
      tickets: null,
      register: null,
      gaps: [
        { source: "git ref main", reason: "git rev-parse failed (exit 128): Permission denied" },
      ],
    });
    expect(html).toContain("@ <code>unresolved</code>");
    expect(html).not.toContain("<code>missing</code>");
  });
});

describe("valid empty data", () => {
  it("still says Idle, none and Quiet when every source was read and is empty", async () => {
    const { state, html } = await page({ runs: [], branches: [] });
    expect(state.runsIncomplete).toBeNull();
    expect(state.failuresIncomplete).toBeNull();
    expect(state.current.lock.held).toBe(false);
    expect(executionStatus(state).kind).toBe("idle");
    expect(html).toContain("No run is active");
    expect(html).toContain(">Quiet<");
    expect(html).toContain("0 succeeded");
    expect(html).toMatch(/Parked branches<\/dt><dd><span class="muted">none/);
  });
});

// An `active` run whose directory could not be listed has no trustworthy file-activity time: the
// fallback (the directory's own mtime) can be old while files inside are being written. "Quiet"
// and "Idle" are claims, so the page must say the run state is unknown, with the reason, unless a
// recent write independently shows the run is live.
describe("unlistable active run directory", () => {
  const RUN = "20261113-110000";
  const REASON = `.ralph/logs/${RUN} could not be listed: EACCES: permission denied`;
  const activeRun = (lastActivity: number) =>
    run(RUN, { runJson: runJson(RUN, "active"), lastActivity, unlisted: [REASON] });

  it("reports the run state unknown, not quiet, stale or idle", async () => {
    const { state, html } = await page({ runs: [activeRun(Date.parse("2026-11-13T09:00:00Z"))] });
    expect(state.runs[0]?.liveness).toBe("unknown");
    expect(executionStatus(state).kind).toBe("unknown");
    for (const claim of ["A run claims to be active, but is quiet", "No run is active", ">Idle<"]) {
      expect(html).not.toContain(claim);
    }
    expect(html).toContain("Run state unknown");
    expect(html).toContain("EACCES: permission denied");
  });

  it("still reports live when a recent write is independent evidence of activity", async () => {
    const { state } = await page({ runs: [activeRun(Date.parse("2026-11-13T11:59:00Z"))] });
    expect(state.runs[0]?.liveness).toBe("live");
    expect(executionStatus(state).kind).toBe("live");
  });
});

// run.json is rewritten in place (no temp file and rename) and is created after its directory, so
// a refresh can find it missing, truncated or unreadable while the run is working. Without a
// usable run.json, only file activity says anything: recent writes leave the run state unknown;
// a fully listed run that has been quiet past the stale threshold cannot be the live one.
describe("unusable run.json", () => {
  const RUN = "20261113-113000";
  const runWithout = (runJsonText: FileText, lastActivity: number) =>
    run(RUN, { runJson: runJsonText, lastActivity });
  const RECENT = Date.parse("2026-11-13T11:59:00Z");
  const OLD = Date.parse("2026-11-13T09:00:00Z");

  for (const [name, text] of [
    ["missing", null],
    ["truncated", '{"run_id":"2026'],
    ["unreadable", { unreadable: "EACCES: permission denied" }],
  ] as const) {
    it(`reports the run state unknown, not idle, when a recently written run's run.json is ${name}`, async () => {
      const { state, html } = await page({ runs: [runWithout(text, RECENT)] });
      const execution = executionStatus(state);
      expect(execution.kind).toBe("unknown");
      expect(execution.reason).toContain(RUN);
      for (const claim of ["No run is active", ">Idle<"]) {
        expect(html).not.toContain(claim);
      }
      expect(html).toContain("Run state unknown");
    });
  }

  it("stays idle when the run without run.json has been quiet past the stale threshold", async () => {
    const { state } = await page({ runs: [runWithout(null, OLD)] });
    expect(state.runs[0]?.liveness).toBe("unknown");
    expect(executionStatus(state).kind).toBe("idle");
  });

  it("stays unknown, however quiet, when run.json exists but cannot be read or parsed", async () => {
    for (const text of ['{"run_id":"2026', { unreadable: "EBUSY: resource busy or locked" }]) {
      const { state, html } = await page({ runs: [runWithout(text, OLD)] });
      expect(executionStatus(state).kind).toBe("unknown");
      expect(html).not.toContain("No run is active");
    }
  });

  it("does not let a malformed session record of an old run without run.json pin it unknown", async () => {
    const { state } = await page({
      runs: [run(RUN, { runJson: null, lastActivity: OLD, sessionsTsv: "not	a	sessions file" })],
    });
    expect(state.runs[0]?.sessionsIncomplete).toEqual(expect.any(String));
    expect(executionStatus(state).kind).toBe("idle");
  });
});
