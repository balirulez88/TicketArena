import { describe, expect, it } from "vitest";
import { buildState } from "./state";
import {
  debtEntry,
  MINUTE,
  NOW,
  register,
  run,
  runJson,
  SESSIONS_HEADER,
  sessionLine,
  snapshot,
  ticket,
  triagedLow,
} from "./testing/fixtures";

const OPTIONS = { staleAfterMs: 15 * MINUTE, failureLimit: 25 };
const build = (overrides: Parameters<typeof snapshot>[0]) =>
  buildState(snapshot(overrides), OPTIONS);

describe("run liveness", () => {
  it("is live only while run.json says active and the run's files changed recently", async () => {
    const state = await build({
      runs: [
        run("20261113-114500", {
          runJson: runJson("20261113-114500", "active"),
          sessionRecords: [sessionLine("2026-11-13T11:50:00Z", "13 green#2", "running")],
          lastActivity: NOW - 2 * MINUTE,
        }),
        run("20261112-090000", {
          runJson: runJson("20261112-090000", "active"),
          sessionRecords: [sessionLine("2026-11-12T09:00:00Z", "14 red#1", "running")],
          lastActivity: NOW - 26 * 60 * MINUTE,
        }),
        run("20261111-090000", { runJson: runJson("20261111-090000", "succeeded") }),
      ],
    });
    expect(state.runs.map((r) => [r.runId, r.liveness, r.provenance])).toEqual([
      ["20261113-114500", "live", "live"],
      ["20261112-090000", "stale", "historical"],
      ["20261111-090000", "finished", "historical"],
    ]);
    // Both claim to be active, so both are listed as current; the page tells them apart.
    expect(state.current.runs.map((r) => [r.runId, r.current?.label])).toEqual([
      ["20261113-114500", "13 green#2"],
      ["20261112-090000", "14 red#1"],
    ]);
  });

  it("reports a run whose run.json is missing or corrupt as unknown, with the reason", async () => {
    const state = await build({
      runs: [
        run("20261110-100000", { runJson: null }),
        run("20261110-110000", { runJson: "{not json" }),
      ],
    });
    expect(state.runs.map((r) => [r.liveness, r.provenance, r.status])).toEqual([
      ["unknown", "unavailable", null],
      ["unknown", "unavailable", null],
    ]);
    expect(state.gaps).toEqual(
      expect.arrayContaining([
        { source: "run 20261110-100000 run.json", reason: "missing" },
        { source: "run 20261110-110000 run.json", reason: expect.stringMatching(/^invalid JSON/) },
      ]),
    );
  });

  it("prefers the merged sessions.tsv over per-process records once the run has ended", async () => {
    const state = await build({
      runs: [
        run("20261110-100000", {
          runJson: runJson("20261110-100000", "failed"),
          sessionsTsv: [
            SESSIONS_HEADER,
            sessionLine("2026-11-10T10:00:00Z", "15 red#1", "interrupted"),
          ].join("\n"),
          sessionRecords: [sessionLine("2026-11-10T10:00:00Z", "15 red#1", "running")],
        }),
      ],
    });
    expect(state.runs[0]?.sessions.map((s) => s.status)).toEqual(["interrupted"]);
    expect(state.runs[0]?.current).toBeNull();
  });
});

describe("tickets", () => {
  it("shows the status line verbatim even while a live run works on the ticket", async () => {
    const state = await build({
      tickets: [ticket("13", "release-hold", "ready-for-agent")],
      runs: [
        run("20261113-114500", {
          runJson: runJson("20261113-114500", "active"),
          sessionRecords: [sessionLine("2026-11-13T11:50:00Z", "13 green#1", "running")],
          lastActivity: NOW - MINUTE,
        }),
      ],
    });
    const [view] = state.tickets ?? [];
    expect(view?.status).toBe("ready-for-agent");
    expect(view?.phase).toMatchObject({ runId: "20261113-114500", liveness: "live" });
    expect(view?.phase?.session.phase).toBe("green");
  });

  it("gives the last recorded phase of a finished run as historical", async () => {
    const state = await build({
      tickets: [ticket("12", "lock-timeout", "blocked")],
      runs: [
        run("20261106-165157", {
          runJson: runJson("20261106-165157", "failed"),
          sessionsTsv: [
            SESSIONS_HEADER,
            sessionLine("2026-11-06T16:51:57Z", "12 review-spec", "ok", "2026-11-06T16:54:00Z"),
            sessionLine("2026-11-06T16:54:22Z", "12 review-fix#1", "ok", "2026-11-06T17:02:00Z"),
          ].join("\n"),
        }),
      ],
    });
    expect(state.tickets?.[0]?.phase).toMatchObject({ liveness: "finished" });
    expect(state.tickets?.[0]?.phase?.session.label).toBe("12 review-fix#1");
  });

  it("resolves blockers across active and archived tickets and derives selectability", async () => {
    const state = await build({
      tickets: [
        ticket("04", "seat-map", "done"),
        ticket("13", "release-hold", "ready-for-agent", ["04"]),
        ticket("14", "hold-expiry", "ready-for-agent", ["13", "99"]),
        ticket("15", "order-expiry", "ready-for-human"),
      ],
    });
    const byNumber = new Map(state.tickets?.map((t) => [t.number, t]));
    expect(byNumber.get("04")?.location).toBe("done");
    expect(byNumber.get("13")).toMatchObject({ blockersDone: true, selectable: true });
    expect(byNumber.get("14")).toMatchObject({
      blockers: [
        { number: "13", status: "ready-for-agent" },
        { number: "99", status: null },
      ],
      blockersDone: false,
      selectable: false,
    });
    expect(byNumber.get("15")?.selectable).toBe(false);
  });

  it("is unavailable as a whole when the ticket files could not be read", async () => {
    const state = await build({
      tickets: null,
      gaps: [{ source: "issues/ at main", reason: "fatal: bad object" }],
    });
    expect(state.tickets).toBeNull();
    expect(state.debt).toBeNull();
    expect(state.gaps).toContainEqual({ source: "issues/ at main", reason: "fatal: bad object" });
  });

  it("attaches the newest loop and host review decisions and the pause record", async () => {
    const decision = (verdict: string) => JSON.stringify({ verdict, blockers: [], findings: [] });
    const state = await build({
      tickets: [ticket("12", "lock-timeout", "blocked")],
      runs: [
        run("20261106-165157", {
          decisions: [
            { name: "12-lock-timeout.review-1.decision.json", text: decision("blocked") },
            { name: "12-lock-timeout.review-3.decision.json", text: decision("approved") },
          ],
        }),
        run("20261105-100000", {
          decisions: [
            { name: "12-lock-timeout.review-1.decision.json", text: decision("invalid") },
          ],
        }),
      ],
      hostReviews: [
        { run: "20261106-175129-16391", slug: "12-lock-timeout", text: decision("blocked") },
      ],
      pauses: [
        {
          name: "12-lock-timeout.pause",
          text: "ticket=12\nref=r\nphase=review\nattempt=1\nround=1\nreason=transient\nrun=x",
        },
      ],
    });
    const view = state.tickets?.[0];
    expect(view?.review.loop).toMatchObject({ run: "20261106-165157", round: 3 });
    expect(view?.review.loop?.decision.verdict).toBe("approved");
    expect(view?.review.host?.decision.verdict).toBe("blocked");
    expect(view?.pause).toMatchObject({ phase: "review", reason: "transient" });
  });
});

describe("technical debt", () => {
  it("uses Ralph's own debt gate: an entry blocking a ticket makes it wait", async () => {
    const state = await build({
      tickets: [
        ticket("01", "x", "done"),
        ticket("02", "owner", "ready-for-agent"),
        ticket("03", "dependent", "ready-for-agent"),
      ],
      register: register(debtEntry("TD-001", triagedLow("03", "ticket 02"))),
    });
    const byNumber = new Map(state.tickets?.map((t) => [t.number, t]));
    expect(byNumber.get("03")?.debt).toEqual({
      state: "waiting",
      reasons: ["TD-001 (CORRECTNESS) until ticket 02 resolves it"],
    });
    expect(byNumber.get("03")?.selectable).toBe(false);
    expect(byNumber.get("02")?.debt?.state).toBe("clear");
    expect(byNumber.get("01")?.debt).toBeNull();
    expect(state.debt?.held.map((held) => held.ticket)).toEqual(["03"]);
    expect(state.debt?.summary).toEqual({ PLANNED: { LOW: 1 } });
  });

  it("holds every ticket while a MEDIUM entry is untriaged", async () => {
    const state = await build({
      tickets: [ticket("02", "a", "ready-for-agent"), ticket("03", "b", "blocked")],
      register: register(
        debtEntry("TD-002", { Status: "OPEN", Severity: "MEDIUM", Triage: "pending" }),
      ),
    });
    expect(state.tickets?.map((t) => t.debt?.state)).toEqual(["needs-triage", "needs-triage"]);
  });

  it("reports an unparseable register as unavailable rather than clearing tickets", async () => {
    const state = await build({
      tickets: [ticket("02", "a", "ready-for-agent")],
      register: "# no markers here",
    });
    expect(state.debt).toBeNull();
    expect(state.tickets?.[0]).toMatchObject({ debt: null, selectable: null });
    expect(state.gaps).toContainEqual({
      source: "docs/technical-debt.md at main",
      reason: expect.stringContaining("ralph-debt:begin"),
    });
  });
});

describe("current batch", () => {
  const batchState = (status: string) =>
    JSON.stringify({ batch: "b1", status, tickets: [], stop: null, max_tickets: 2 });

  it("is live only when its state says running and the lock is held", async () => {
    const locked = await build({
      batch: { state: batchState("running"), lock: { owner: '{"pid":7,"host":"h"}' } },
    });
    expect(locked.current.batch.provenance).toBe("live");
    expect(locked.current.lock).toEqual({
      held: true,
      owner: { pid: 7, host: "h", startedAt: null },
    });

    // A paused or killed batch stays `running` in state.json so it can resume; without the lock
    // nothing is running it.
    const unlocked = await build({ batch: { state: batchState("running"), lock: null } });
    expect(unlocked.current.batch.provenance).toBe("historical");
    expect(unlocked.current.lock.held).toBe(false);
  });

  it("treats a lock with an unreadable owner as held by an unknown owner", async () => {
    const state = await build({ batch: { state: null, lock: { owner: null } } });
    expect(state.current.lock).toEqual({ held: true, owner: null });
    expect(state.current.batch).toEqual({ provenance: "unavailable", value: null });
  });
});

describe("recent failures", () => {
  it("collects failed sessions and runs, sandbox refusals, quarantine branches and batch stops, newest first", async () => {
    const state = await build({
      runs: [
        run("20261108-175232", {
          runJson: runJson("20261108-175232", "failed", "2026-11-08T18:27:48Z"),
          sessionsTsv: [
            SESSIONS_HEADER,
            sessionLine("2026-11-08T17:52:33Z", "54 lead", "ok", "2026-11-08T18:26:50Z"),
            sessionLine("2026-11-08T17:10:00Z", "54 review-spec", "failed", "2026-11-08T17:20:00Z"),
          ].join("\n"),
        }),
      ],
      sandboxes: [
        {
          id: "20261105-213602-2573",
          verdict: '{"exit":3,"outcome":"untrusted","reason":"TD-026 needs Verification"}',
          decidedAt: Date.parse("2026-11-05T21:00:00Z"),
          lastActivity: null,
        },
        {
          id: "20261105-100000-1",
          verdict: '{"exit":0,"outcome":"merged"}',
          decidedAt: Date.parse("2026-11-05T11:00:00Z"),
          lastActivity: null,
        },
      ],
      hostReviews: [{ run: "20261105-213602-2573", slug: "11-x", text: '{"verdict":"approved"}' }],
      branches: [
        {
          name: "rejected/54-transaction-timeouts-20261108-175232",
          sha: "abc",
          date: "2026-11-08T18:27:27Z",
          subject: "wip(ralph): rejected: RED not re-proved",
        },
        { name: "ralph/paused/12-x", sha: "def", date: "2026-11-06T16:00:00Z", subject: "wip" },
      ],
      batch: {
        state: JSON.stringify({
          batch: "b",
          status: "stopped",
          tickets: [{ number: "12", slug: "12-x", stage: "rejected" }],
          stop: {
            reason: "rejected",
            detail: "ticket 12 was rejected",
            at: "2026-11-06T18:09:06Z",
          },
        }),
        lock: null,
      },
    });
    expect(state.failures.map((f) => [f.kind, f.ticket])).toEqual([
      ["run failed", "54"],
      ["quarantined", "54"],
      ["session failed", "54"],
      ["batch rejected", "12"],
      ["sandbox untrusted", "11"],
    ]);
    expect(state.current.pausedBranches?.map((b) => b.name)).toEqual(["ralph/paused/12-x"]);
  });

  it("does not count a batch that stopped normally", async () => {
    const state = await build({
      batch: {
        state: JSON.stringify({
          batch: "b",
          status: "finished",
          tickets: [],
          stop: { reason: "batch-limit", detail: "2 merged", at: "2026-11-06T18:09:06Z" },
        }),
        lock: null,
      },
    });
    expect(state.failures).toEqual([]);
  });

  it("is bounded by the failure limit", async () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      sessionLine(
        `2026-11-08T10:${String(i).padStart(2, "0")}:00Z`,
        "54 red#1",
        "failed",
        `2026-11-08T10:${String(i).padStart(2, "0")}:30Z`,
      ),
    );
    const state = await build({
      runs: [run("20261108-100000", { sessionsTsv: [SESSIONS_HEADER, ...lines].join("\n") })],
    });
    expect(state.failures).toHaveLength(25);
    expect(state.failures[0]?.at).toBe("2026-11-08T10:29:30Z");
  });
});
