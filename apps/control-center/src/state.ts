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
  Parsed,
  PauseState,
  Provenance,
  ReviewDecision,
  Session,
  Ticket,
} from "./model";
import type { FileText, RunFiles, Snapshot } from "./snapshot";
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
  /** Why run.json gave no status (missing, unreadable or malformed); null when it did. */
  statusProblem: string | null;
  /** Whether a listing inside the run failed, so its file activity time may be too old. */
  unlisted: boolean;
  /** Why `sessions` may lack records (one unreadable or malformed); null when all were read. */
  sessionsIncomplete: string | null;
  /** The newest session still recorded as `running` (runs run.json calls active only). */
  current: Session | null;
}

/**
 * A review decision that exists, or may exist, but could not be used. A null `run` or `slug`
 * means any: a failed listing hides every review below it.
 */
export interface ReviewGap {
  kind: "loop" | "host";
  run: string | null;
  slug: string | null;
  reason: string;
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
    /** `held` is null when the lock directory could not be checked. */
    lock: { held: boolean | null; owner: LockOwner | null };
    pauses: PauseState[];
    /** Why `pauses` may lack a pause record; null when every one was read. */
    pausesIncomplete: string | null;
    /** Null when Git could not list the branches. */
    pausedBranches: GitBranch[] | null;
  };
  runs: RunView[];
  /** Why `runs` may lack run directories (no .ralph/, a failed listing); null when complete. */
  runsIncomplete: string | null;
  reviews: ReviewView[];
  reviewGaps: ReviewGap[];
  debt: {
    entries: DebtEntry[];
    summary: Record<string, Record<string, number>>;
    held: { ticket: string; verdict: DebtVerdict }[];
  } | null;
  failures: FailureView[];
  /** Why `failures` may lack entries (a source it is built from was unusable); null when complete. */
  failuresIncomplete: string | null;
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

const joined = (reasons: string[]): string | null =>
  reasons.length === 0 ? null : [...new Set(reasons)].join("; ");

/**
 * Parses a file that may be absent (null) or unreadable. An unreadable file fails like a malformed
 * one: its content is unknown either way, and the caller must not treat it as absent.
 */
function parseFile<T>(file: FileText, parse: (text: string) => Parsed<T>): Parsed<T> | null {
  if (file === null) {
    return null;
  }
  return typeof file === "string"
    ? parse(file)
    : { ok: false, reason: `unreadable: ${file.unreadable}` };
}

function sessionsOf(run: RunFiles, gaps: Gap[]): { sessions: Session[]; problems: string[] } {
  // sessions.tsv is the merged, final record; until the run ends only the per-process records
  // exist, and a `running` one there is the session in progress. An unreadable sessions.tsv is
  // not "not merged yet": falling back to the per-process records would show a stale picture.
  const sources = run.sessionsTsv === null ? run.sessionRecords : [run.sessionsTsv];
  const sessions: Session[] = [];
  const problems = [...run.unlisted];
  for (const file of sources) {
    const parsed = parseFile(file, parseSessionsTsv);
    if (parsed?.ok) {
      sessions.push(...parsed.value);
    } else if (parsed) {
      gaps.push({ source: `run ${run.runId} session records`, reason: parsed.reason });
      problems.push(parsed.reason);
    }
  }
  return { sessions: sessions.sort((a, b) => a.started.localeCompare(b.started)), problems };
}

function livenessOf(status: string | null, run: RunFiles, now: number, staleAfterMs: number) {
  if (status === "active") {
    const recent = run.lastActivity !== null && now - run.lastActivity <= staleAfterMs;
    if (recent) {
      return "live";
    }
    // Quiet is a claim about every file in the run: with a listing failed, a file being written
    // right now may be the one nobody saw, so the run is neither stale nor finished but unknown.
    return run.unlisted.length > 0 ? "unknown" : "stale";
  }
  return status !== null && FINISHED_RUN.includes(status) ? "finished" : "unknown";
}

/**
 * Every run run.json calls active (including one whose activity could not be checked), every run
 * whose run.json exists but could not be read or parsed (it may say active; a live run can be
 * quiet for a whole agent session), and every run without run.json that may still be working: one
 * written to recently (run.json is written right after its directory), or one whose files could
 * not all be listed. A fully listed run without run.json, quiet past the stale threshold, cannot
 * be the live one and does not hold the execution status at unknown.
 */
const MISSING = "missing";
const MISSING_RUN_JSON = `run.json ${MISSING}`;

function mayBeActive(run: RunView, now: number, staleAfterMs: number): boolean {
  if (run.status === "active") {
    return true;
  }
  if (run.status !== null) {
    return false;
  }
  if (run.statusProblem !== MISSING_RUN_JSON) {
    return true;
  }
  const recent = run.lastActivity !== null && now - run.lastActivity <= staleAfterMs;
  return recent || run.unlisted;
}

const PROVENANCE: Record<Liveness, Provenance> = {
  live: "live",
  stale: "historical",
  finished: "historical",
  unknown: "unavailable",
};

export function mapRun(run: RunFiles, now: number, staleAfterMs: number, gaps: Gap[]): RunView {
  const record = parseFile(run.runJson, parseRunJson);
  const statusProblem = record === null ? MISSING : record.ok ? null : record.reason;
  if (statusProblem !== null) {
    gaps.push({ source: `run ${run.runId} run.json`, reason: statusProblem });
  }
  const status = record?.ok ? record.value.status : null;
  const { sessions, problems } = sessionsOf(run, gaps);
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
    statusProblem: statusProblem === null ? null : `run.json ${statusProblem}`,
    unlisted: run.unlisted.length > 0,
    sessionsIncomplete: joined(problems),
    current: status === "active" ? (running.at(-1) ?? null) : null,
  };
}

// The host writes decision.json last; a folder without one is a review in progress or one that
// stopped before deciding. Either way it is not "no review".
const NO_HOST_DECISION = "no decision.json (review still running, or it stopped before deciding)";

function collectReviews(snapshot: Snapshot, gaps: Gap[]) {
  const reviews: ReviewView[] = [];
  const reviewGaps: ReviewGap[] = [];
  const add = (view: Omit<ReviewView, "decision">, file: FileText, source: string) => {
    const decision = parseFile(file, parseDecision) ?? { ok: false, reason: NO_HOST_DECISION };
    if (decision.ok) {
      reviews.push({ ...view, decision: decision.value });
    } else {
      gaps.push({ source, reason: decision.reason });
      reviewGaps.push({ kind: view.kind, run: view.run, slug: view.slug, reason: decision.reason });
    }
  };
  for (const run of snapshot.runs) {
    for (const reason of run.unlisted) {
      reviewGaps.push({ kind: "loop", run: run.runId, slug: null, reason });
    }
    for (const { name, text } of run.decisions) {
      const match = /^(.+)\.review-(\d+)\.decision\.json$/.exec(name);
      if (match?.[1] && match[2]) {
        const view = { kind: "loop" as const, run: run.runId, slug: match[1] };
        add({ ...view, round: Number(match[2]) }, text, `run ${run.runId} ${name}`);
      }
    }
  }
  for (const reason of snapshot.incomplete.runs) {
    reviewGaps.push({ kind: "loop", run: null, slug: null, reason });
  }
  for (const reason of snapshot.incomplete.hostReviews) {
    reviewGaps.push({ kind: "host", run: null, slug: null, reason });
  }
  for (const { run, slug, text } of snapshot.hostReviews) {
    add({ kind: "host", run, slug, round: null }, text, `host review ${run}/${slug}`);
  }
  return {
    reviews: reviews.sort(
      (a, b) => timeKey(b.run).localeCompare(timeKey(a.run)) || (b.round ?? 0) - (a.round ?? 0),
    ),
    reviewGaps,
  };
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

function sandboxFailures(snapshot: Snapshot, gaps: Gap[], problems: string[]): FailureView[] {
  const failures: FailureView[] = [];
  for (const sandbox of snapshot.sandboxes) {
    const verdict = parseFile(sandbox.verdict, parseSandboxVerdict);
    if (verdict === null) {
      continue;
    }
    if (!verdict.ok) {
      gaps.push({ source: `sandbox ${sandbox.id} verdict.json`, reason: verdict.reason });
      problems.push(`sandbox ${sandbox.id} verdict.json: ${verdict.reason}`);
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

function readBatch(
  snapshot: Snapshot,
  gaps: Gap[],
  problems: string[],
): DashboardState["current"]["batch"] {
  const parsed = parseFile(snapshot.batch.state, parseBatchState);
  if (parsed === null) {
    return { provenance: "unavailable", value: null };
  }
  if (!parsed.ok) {
    gaps.push({ source: ".ralph/batch/state.json", reason: parsed.reason });
    problems.push(`.ralph/batch/state.json: ${parsed.reason}`);
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
    return { held: snapshot.incomplete.lock.length > 0 ? null : false, owner: null };
  }
  const owner = parseFile(lock.owner, parseLockOwner);
  if (owner !== null && !owner.ok) {
    gaps.push({ source: ".ralph/batch/lock/owner.json", reason: owner.reason });
  }
  return { held: true, owner: owner?.ok ? owner.value : null };
}

function readPauses(snapshot: Snapshot, gaps: Gap[]) {
  const problems = [...snapshot.incomplete.pauses];
  const pauses = snapshot.pauses.flatMap(({ name, text }) => {
    // Listed, so never absent: a null here would only mean it vanished, which is unknown too.
    const parsed = parseFile(text, parsePause) ?? { ok: false, reason: "missing" };
    if (!parsed.ok) {
      gaps.push({ source: `.ralph/state/${name}`, reason: parsed.reason });
      problems.push(`.ralph/state/${name}: ${parsed.reason}`);
    }
    return parsed.ok ? [parsed.value] : [];
  });
  return { pauses, incomplete: joined(problems) };
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
  const { reviews, reviewGaps } = collectReviews(snapshot, gaps);
  // Every source the failure list is built from that could not be fully used.
  const failureProblems = [...snapshot.incomplete.runs];
  for (const run of runs) {
    if (run.sessionsIncomplete !== null) {
      failureProblems.push(`run ${run.runId} sessions: ${run.sessionsIncomplete}`);
    }
    if (run.status === null) {
      failureProblems.push(`run ${run.runId} run.json unusable`);
    }
  }
  if (snapshot.branches === null) {
    failureProblems.push("git branches rejected/* could not be listed");
  }
  const batch = readBatch(snapshot, gaps, failureProblems);
  const { pauses, incomplete: pausesIncomplete } = readPauses(snapshot, gaps);
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
    ...sandboxFailures(snapshot, gaps, failureProblems),
    ...branchFailures(snapshot.branches ?? []),
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
      runs: runs.filter((run) => mayBeActive(run, now, options.staleAfterMs)),
      batch,
      lock: readLock(snapshot, gaps),
      pauses,
      pausesIncomplete,
      pausedBranches: snapshot.branches?.filter((b) => b.name.startsWith("ralph/paused/")) ?? null,
    },
    runs,
    runsIncomplete: joined(snapshot.incomplete.runs),
    reviews,
    reviewGaps,
    debt: debt && {
      entries: debt.entries,
      summary: summarize(debt.entries),
      held: [...debt.verdicts]
        .filter(([, verdict]) => verdict.state !== "clear")
        .map(([ticket, verdict]) => ({ ticket, verdict }))
        .sort((a, b) => a.ticket.localeCompare(b.ticket)),
    },
    failures,
    failuresIncomplete: joined(failureProblems),
    gaps,
  };
}
