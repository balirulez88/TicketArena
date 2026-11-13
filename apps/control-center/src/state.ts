// Maps a snapshot of raw artifacts to what the page shows. The rules, all derived from how the
// harness writes its artifacts (docs/workflow/index.md), never from guesses:
//
// - A ticket's status is its `**Status:**` line at the ref, verbatim. Nothing on this page
//   overrides it, not even a live run working on that ticket.
// - A run is `live` only while its run.json says `active` AND its directory changed within
//   `staleAfterMs`. An `active` run that has gone quiet is `stale`: the harness leaves a killed
//   run `active` forever, and process liveness cannot be checked from artifacts (sandbox
//   containers are unnamed), so the page says what it knows rather than calling it running.
// - An agent phase comes from a session record's label (`12 green#2`). A phase is current only
//   in a live run; otherwise it is the last one recorded.

import {
  parseBatchState,
  parseDecision,
  parseLockOwner,
  parsePause,
  parseRunJson,
  parseSandboxVerdict,
  parseSessionsTsv,
} from "./artifacts";
import { type DebtEntry, type DebtVerdict, evaluateDebt } from "./debt";
import type {
  BatchState,
  Gap,
  GitBranch,
  LockOwner,
  PauseState,
  Provenance,
  ReviewDecision,
  Session,
  Ticket,
} from "./model";
import type { RunFiles, Snapshot } from "./snapshot";
import { parseTicketFile } from "./tickets";

export type Liveness = "live" | "stale" | "finished" | "unknown";

export interface RunView {
  runId: string;
  origin: string;
  /** run.json status verbatim, or null when run.json is missing or unreadable. */
  status: string | null;
  liveness: Liveness;
  provenance: Provenance;
  lastActivity: number | null;
  tickets: string[];
  startedAt: string | null;
  finishedAt: string | null;
  sessions: Session[];
  /** The newest session still recorded as `running` (live or stale runs only). */
  current: Session | null;
}

export interface ReviewView {
  /** `loop`: a review round inside the run; `host`: the host's deciding review (ADR 0015). */
  kind: "loop" | "host";
  run: string;
  slug: string;
  round: number | null;
  decision: ReviewDecision;
}

export interface PhaseView {
  runId: string;
  session: Session;
  liveness: Liveness;
}

export interface BlockerView {
  number: string;
  status: string | null;
}

export interface TicketView extends Ticket {
  blockers: BlockerView[];
  blockersDone: boolean;
  debt: DebtVerdict | null;
  /**
   * Whether Ralph's selection rule (`ready-for-agent`, every blocker `done`, debt gate `clear`)
   * holds for this ticket; null when the debt gate could not be computed.
   */
  selectable: boolean | null;
  phase: PhaseView | null;
  review: { loop: ReviewView | null; host: ReviewView | null };
  pause: PauseState | null;
}

export interface FailureView {
  at: string;
  kind: string;
  ticket: string | null;
  detail: string;
  source: string;
}

export interface DashboardState {
  generatedAt: string;
  source: { root: string; ref: string; commit: string | null };
  staleAfterMinutes: number;
  tickets: TicketView[] | null;
  current: {
    runs: RunView[];
    batch: { provenance: Provenance; value: BatchState | null };
    lock: { held: boolean; owner: LockOwner | null };
    pauses: PauseState[];
    pausedBranches: GitBranch[];
  };
  runs: RunView[];
  reviews: ReviewView[];
  debt: {
    entries: DebtEntry[];
    summary: Record<string, Record<string, number>>;
    held: { ticket: string; verdict: DebtVerdict }[];
  } | null;
  failures: FailureView[];
  gaps: Gap[];
}

export interface StateOptions {
  staleAfterMs: number;
  failureLimit: number;
}

const FAILED_SESSION = ["failed", "timed-out", "interrupted"];
const FINISHED_RUN = ["succeeded", "failed", "paused"];
// ralph-batch.mjs stop reasons that end a batch normally (exit 0 or 2).
const BENIGN_STOPS = ["batch-limit", "no-eligible-ticket", "unresolved-dependency"];

/** Run ids, host-review ids and sandbox ids all start with a local timestamp; sort on it. */
export const timeKey = (id: string): string => id.replace(/\D/g, "").slice(0, 14);
const newestFirst =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    key(b).localeCompare(key(a));

function sessionsOf(run: RunFiles, gaps: Gap[]): Session[] {
  // sessions.tsv is the merged, final record; until the run ends only the per-process records
  // exist, and a `running` one there is the session in progress.
  const sources = run.sessionsTsv === null ? run.sessionRecords : [run.sessionsTsv];
  const sessions: Session[] = [];
  for (const text of sources) {
    const parsed = parseSessionsTsv(text);
    if (parsed.ok) {
      sessions.push(...parsed.value);
    } else {
      gaps.push({ source: `run ${run.runId} session records`, reason: parsed.reason });
    }
  }
  return sessions.sort((a, b) => a.started.localeCompare(b.started));
}

function livenessOf(status: string | null, run: RunFiles, now: number, staleAfterMs: number) {
  if (status === "active") {
    const quiet = run.lastActivity === null || now - run.lastActivity > staleAfterMs;
    return quiet ? "stale" : "live";
  }
  return status !== null && FINISHED_RUN.includes(status) ? "finished" : "unknown";
}

const PROVENANCE: Record<Liveness, Provenance> = {
  live: "live",
  stale: "historical",
  finished: "historical",
  unknown: "unavailable",
};

export function mapRun(run: RunFiles, now: number, staleAfterMs: number, gaps: Gap[]): RunView {
  const record = run.runJson === null ? null : parseRunJson(run.runJson);
  if (record === null) {
    gaps.push({ source: `run ${run.runId} run.json`, reason: "missing" });
  } else if (!record.ok) {
    gaps.push({ source: `run ${run.runId} run.json`, reason: record.reason });
  }
  const status = record?.ok ? record.value.status : null;
  const sessions = sessionsOf(run, gaps);
  const liveness = livenessOf(status, run, now, staleAfterMs);
  const running = sessions.filter((session) => session.status === "running");
  const tickets = [
    ...new Set(sessions.flatMap((session) => (session.ticket ? [session.ticket] : []))),
  ];
  return {
    runId: run.runId,
    origin: run.origin,
    status,
    liveness,
    provenance: PROVENANCE[liveness],
    lastActivity: run.lastActivity,
    tickets,
    // Host-imported runs carry a run.json the host wrote at import (start == finish), so the
    // first session is the better start time when there is one.
    startedAt: sessions[0]?.started ?? (record?.ok ? record.value.startedAt : null),
    finishedAt: record?.ok && liveness === "finished" ? record.value.finishedAt : null,
    sessions,
    current: liveness === "live" || liveness === "stale" ? (running.at(-1) ?? null) : null,
  };
}

function collectReviews(snapshot: Snapshot, gaps: Gap[]): ReviewView[] {
  const reviews: ReviewView[] = [];
  const add = (view: Omit<ReviewView, "decision">, text: string, source: string) => {
    const decision = parseDecision(text);
    if (decision.ok) {
      reviews.push({ ...view, decision: decision.value });
    } else {
      gaps.push({ source, reason: decision.reason });
    }
  };
  for (const run of snapshot.runs) {
    for (const { name, text } of run.decisions) {
      const match = /^(.+)\.review-(\d+)\.decision\.json$/.exec(name);
      if (match?.[1] && match[2]) {
        const view = { kind: "loop" as const, run: run.runId, slug: match[1] };
        add({ ...view, round: Number(match[2]) }, text, `run ${run.runId} ${name}`);
      }
    }
  }
  for (const { run, slug, text } of snapshot.hostReviews) {
    add({ kind: "host", run, slug, round: null }, text, `host review ${run}/${slug}`);
  }
  return reviews.sort(
    (a, b) => timeKey(b.run).localeCompare(timeKey(a.run)) || (b.round ?? 0) - (a.round ?? 0),
  );
}

function collectTickets(snapshot: Snapshot): Ticket[] | null {
  return (
    snapshot.tickets?.map(({ path, text }) =>
      parseTicketFile(
        path.split("/").pop() ?? path,
        text,
        path.startsWith("issues/done/") ? "done" : "active",
      ),
    ) ?? null
  );
}

function latestPhase(number: string, runs: RunView[]): PhaseView | null {
  for (const run of runs) {
    const sessions = run.sessions.filter((session) => session.ticket === number);
    const session = run.current?.ticket === number ? run.current : (sessions.at(-1) ?? undefined);
    if (session) {
      return { runId: run.runId, session, liveness: run.liveness };
    }
  }
  return null;
}

interface TicketContext {
  byNumber: Map<string, Ticket>;
  verdicts: Map<string, DebtVerdict> | null;
  runs: RunView[];
  reviews: ReviewView[];
  pauses: PauseState[];
}

function viewTicket(ticket: Ticket, context: TicketContext): TicketView {
  const blockers = ticket.blockedBy.map((number) => ({
    number,
    status: context.byNumber.get(number)?.status ?? null,
  }));
  const blockersDone = blockers.every((blocker) => blocker.status === "done");
  const debt = ticket.status === "done" ? null : (context.verdicts?.get(ticket.number) ?? null);
  const ownReviews = context.reviews.filter((review) => review.slug === ticket.slug);
  return {
    ...ticket,
    blockers,
    blockersDone,
    debt,
    selectable:
      context.verdicts === null
        ? null
        : ticket.status === "ready-for-agent" && blockersDone && debt?.state === "clear",
    phase: latestPhase(ticket.number, context.runs),
    review: {
      loop: ownReviews.find((review) => review.kind === "loop") ?? null,
      host: ownReviews.find((review) => review.kind === "host") ?? null,
    },
    pause: context.pauses.find((pause) => pause.ticket === ticket.number) ?? null,
  };
}

function summarize(entries: DebtEntry[]): Record<string, Record<string, number>> {
  const summary: Record<string, Record<string, number>> = {};
  for (const entry of entries) {
    const row = summary[entry.status] ?? {};
    row[entry.severity] = (row[entry.severity] ?? 0) + 1;
    summary[entry.status] = row;
  }
  return summary;
}

function runFailures(runs: RunView[]): FailureView[] {
  const failures: FailureView[] = [];
  for (const run of runs) {
    for (const session of run.sessions.filter((s) => FAILED_SESSION.includes(s.status))) {
      failures.push({
        at: session.finished ?? session.started,
        kind: `session ${session.status}`,
        ticket: session.ticket,
        detail: `${session.label} (exit ${session.exit})`,
        source: `run ${run.runId}`,
      });
    }
    if (run.status === "failed" || run.status === "paused") {
      failures.push({
        at: run.finishedAt ?? run.sessions.at(-1)?.finished ?? run.startedAt ?? run.runId,
        kind: `run ${run.status}`,
        ticket: run.tickets.join(", ") || null,
        detail: `run.json status ${run.status}`,
        source: `run ${run.runId}`,
      });
    }
  }
  return failures;
}

function sandboxFailures(snapshot: Snapshot, gaps: Gap[]): FailureView[] {
  const failures: FailureView[] = [];
  for (const sandbox of snapshot.sandboxes) {
    if (sandbox.verdict === null) {
      continue;
    }
    const verdict = parseSandboxVerdict(sandbox.verdict);
    if (!verdict.ok) {
      gaps.push({ source: `sandbox ${sandbox.id} verdict.json`, reason: verdict.reason });
    } else if (verdict.value.exit !== 0) {
      failures.push({
        // The verdict file's own time: sandbox ids are host-local timestamps without a zone.
        at: sandbox.decidedAt === null ? sandbox.id : new Date(sandbox.decidedAt).toISOString(),
        kind: `sandbox ${verdict.value.outcome}`,
        // The host review of a sandbox run lives under the same id, one folder per ticket slug.
        ticket:
          snapshot.hostReviews
            .filter((review) => review.run === sandbox.id)
            .map((review) => review.slug.slice(0, 2))
            .join(", ") || null,
        detail: `exit ${verdict.value.exit}${verdict.value.reason ? `: ${verdict.value.reason}` : ""}`,
        source: `.ralph/sandbox/${sandbox.id}/verdict.json`,
      });
    }
  }
  return failures;
}

function branchFailures(branches: GitBranch[]): FailureView[] {
  return branches
    .filter((branch) => branch.name.startsWith("rejected/"))
    .map((branch) => ({
      at: branch.date,
      kind: "quarantined",
      ticket: /^rejected\/(\d{2})-/.exec(branch.name)?.[1] ?? null,
      detail: `${branch.name}: ${branch.subject}`,
      source: `git branch ${branch.name}`,
    }));
}

function batchFailure(batch: BatchState | null): FailureView[] {
  if (!batch?.stop || BENIGN_STOPS.includes(batch.stop.reason)) {
    return [];
  }
  return [
    {
      at: batch.stop.at || batch.updatedAt || batch.batch,
      kind: `batch ${batch.stop.reason}`,
      ticket: batch.tickets.map((ticket) => ticket.number).join(", ") || null,
      detail: batch.stop.detail,
      source: ".ralph/batch/state.json",
    },
  ];
}

// Failures carry ISO times; one without a parseable time (an id fallback) sorts last.
const byTimeNewestFirst = (a: FailureView, b: FailureView): number =>
  (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);

function readBatch(snapshot: Snapshot, gaps: Gap[]): DashboardState["current"]["batch"] {
  if (snapshot.batch.state === null) {
    return { provenance: "unavailable", value: null };
  }
  const parsed = parseBatchState(snapshot.batch.state);
  if (!parsed.ok) {
    gaps.push({ source: ".ralph/batch/state.json", reason: parsed.reason });
    return { provenance: "unavailable", value: null };
  }
  // ralph-batch.mjs leaves a resumable batch `running` after it stops (a pause, a killed host), so
  // only a held lock alongside makes it a batch in progress.
  const live = parsed.value.status === "running" && snapshot.batch.lock !== null;
  return { provenance: live ? "live" : "historical", value: parsed.value };
}

function readLock(snapshot: Snapshot, gaps: Gap[]): DashboardState["current"]["lock"] {
  const { lock } = snapshot.batch;
  if (lock === null) {
    return { held: false, owner: null };
  }
  const owner = lock.owner === null ? null : parseLockOwner(lock.owner);
  if (owner !== null && !owner.ok) {
    gaps.push({ source: ".ralph/batch/lock/owner.json", reason: owner.reason });
  }
  return { held: true, owner: owner?.ok ? owner.value : null };
}

function readPauses(snapshot: Snapshot, gaps: Gap[]): PauseState[] {
  return snapshot.pauses.flatMap(({ name, text }) => {
    const parsed = parsePause(text);
    if (!parsed.ok) {
      gaps.push({ source: `.ralph/state/${name}`, reason: parsed.reason });
    }
    return parsed.ok ? [parsed.value] : [];
  });
}

async function readDebt(snapshot: Snapshot, tickets: Ticket[] | null, gaps: Gap[]) {
  if (snapshot.register === null || tickets === null) {
    return null;
  }
  try {
    return await evaluateDebt(snapshot.register, tickets);
  } catch (error) {
    gaps.push({
      source: `docs/technical-debt.md at ${snapshot.ref}`,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function buildState(
  snapshot: Snapshot,
  options: StateOptions,
): Promise<DashboardState> {
  const gaps = [...snapshot.gaps];
  const now = snapshot.takenAt;
  const runs = snapshot.runs
    .map((run) => mapRun(run, now, options.staleAfterMs, gaps))
    .sort(newestFirst((run) => timeKey(run.runId)));
  const reviews = collectReviews(snapshot, gaps);
  const batch = readBatch(snapshot, gaps);
  const pauses = readPauses(snapshot, gaps);
  const tickets = collectTickets(snapshot);
  const debt = await readDebt(snapshot, tickets, gaps);

  const context: TicketContext = {
    byNumber: new Map((tickets ?? []).map((ticket) => [ticket.number, ticket])),
    verdicts: debt?.verdicts ?? null,
    runs,
    reviews,
    pauses,
  };
  const failures = [
    ...runFailures(runs),
    ...sandboxFailures(snapshot, gaps),
    ...branchFailures(snapshot.branches),
    ...batchFailure(batch.value),
  ]
    .sort(byTimeNewestFirst)
    .slice(0, options.failureLimit);

  return {
    generatedAt: new Date(now).toISOString(),
    source: { root: snapshot.root, ref: snapshot.ref, commit: snapshot.commit },
    staleAfterMinutes: Math.round(options.staleAfterMs / 60_000),
    tickets: tickets?.map((ticket) => viewTicket(ticket, context)) ?? null,
    current: {
      runs: runs.filter((run) => run.liveness === "live" || run.liveness === "stale"),
      batch,
      lock: readLock(snapshot, gaps),
      pauses,
      pausedBranches: snapshot.branches.filter((b) => b.name.startsWith("ralph/paused/")),
    },
    runs,
    reviews,
    debt: debt && {
      entries: debt.entries,
      summary: summarize(debt.entries),
      held: [...debt.verdicts]
        .filter(([, verdict]) => verdict.state !== "clear")
        .map(([ticket, verdict]) => ({ ticket, verdict }))
        .sort((a, b) => a.ticket.localeCompare(b.ticket)),
    },
    failures,
    gaps,
  };
}
