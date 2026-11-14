// Presentation logic: turns the dashboard state into what the views show. Kept pure and separate
// from the HTML so every rule that could misrepresent Ralph's state is tested on its own.
//
// Two rules hold throughout:
// - A ticket's status is its `**Status:**` line. Eligibility is *calculated* from Ralph's selection
//   rule and is always presented as such, next to the status, never in place of it.
// - A pipeline stage is shown as reached only when a run artifact records it. Ralph writes no
//   planning record, and a Lead session covers every stage at once, so those stay `unknown`.

import type { DebtEntry, DebtVerdict } from "./debt";
import type { SESSION_STATUSES, Session } from "./model";
import type { DashboardState, FailureView, ReviewView, RunView, TicketView } from "./state";

// ---------------------------------------------------------------------------------------------
// Tickets

/** Calculated from Ralph's selection rule; meaningful only for `ready-for-agent` tickets. */
export type Eligibility =
  | "eligible"
  | "waiting-blockers"
  | "waiting-debt"
  | "debt-triage"
  | "unknown"
  | "not-applicable";

export function eligibilityOf(ticket: TicketView): Eligibility {
  if (ticket.status !== "ready-for-agent") {
    return "not-applicable";
  }
  if (!ticket.blockersDone) {
    return "waiting-blockers";
  }
  if (ticket.debt === null || ticket.selectable === null) {
    return "unknown";
  }
  if (ticket.debt.state === "needs-triage") {
    return "debt-triage";
  }
  if (ticket.debt.state === "waiting") {
    return "waiting-debt";
  }
  return ticket.selectable ? "eligible" : "unknown";
}

export const ELIGIBILITY_LABEL: Record<Eligibility, string> = {
  eligible: "eligible",
  "waiting-blockers": "waiting on blockers",
  "waiting-debt": "held by debt",
  "debt-triage": "debt needs triage",
  unknown: "eligibility unknown",
  "not-applicable": "n/a",
};

export interface TicketCounts {
  /** `ready-for-agent` and selectable now (calculated). */
  eligible: number;
  /** `ready-for-agent` but held by blockers or the debt gate (calculated). */
  waiting: number;
  /** `ready-for-agent` whose eligibility could not be computed. */
  eligibilityUnknown: number;
  inProgress: number;
  blocked: number;
  readyForHuman: number;
  done: number;
  unrecognized: number;
  total: number;
}

export function ticketCounts(tickets: TicketView[]): TicketCounts {
  const counts: TicketCounts = {
    eligible: 0,
    waiting: 0,
    eligibilityUnknown: 0,
    inProgress: 0,
    blocked: 0,
    readyForHuman: 0,
    done: 0,
    unrecognized: 0,
    total: tickets.length,
  };
  for (const ticket of tickets) {
    if (!ticket.statusRecognized) {
      counts.unrecognized += 1;
      continue;
    }
    switch (ticket.status) {
      case "ready-for-agent": {
        const eligibility = eligibilityOf(ticket);
        if (eligibility === "eligible") {
          counts.eligible += 1;
        } else if (eligibility === "unknown") {
          counts.eligibilityUnknown += 1;
        } else {
          counts.waiting += 1;
        }
        break;
      }
      case "in-progress":
        counts.inProgress += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "ready-for-human":
        counts.readyForHuman += 1;
        break;
      case "done":
        counts.done += 1;
        break;
      default:
        counts.unrecognized += 1;
    }
  }
  return counts;
}

export interface BoardColumn {
  /** The verbatim status value, or `unrecognized` for anything outside issues/README.md. */
  key: string;
  title: string;
  tickets: TicketView[];
}

const COLUMNS: { key: string; title: string }[] = [
  { key: "ready-for-agent", title: "Ready for agent" },
  { key: "in-progress", title: "In progress" },
  { key: "blocked", title: "Blocked" },
  { key: "ready-for-human", title: "Ready for human" },
  { key: "done", title: "Done" },
];

const byNumber = (a: TicketView, b: TicketView) => a.number.localeCompare(b.number);

/**
 * One column per ticket status, grouped by the status line alone. A ticket whose status is not a
 * recognized value gets its own column instead of being mapped onto the nearest one.
 */
export function boardColumns(tickets: TicketView[]): BoardColumn[] {
  const columns = COLUMNS.map(({ key, title }) => ({
    key,
    title,
    tickets: tickets.filter((t) => t.statusRecognized && t.status === key).sort(byNumber),
  }));
  const unrecognized = tickets.filter((t) => !t.statusRecognized).sort(byNumber);
  if (unrecognized.length > 0) {
    columns.push({ key: "unrecognized", title: "Unrecognized status", tickets: unrecognized });
  }
  return columns;
}

// ---------------------------------------------------------------------------------------------
// Runs and pipelines

export const STAGES = ["planning", "implementation", "testing", "review", "merge"] as const;
export type Stage = (typeof STAGES)[number];
export type StageState = "active" | "completed" | "failed" | "stale" | "unknown";

export const STAGE_TITLE: Record<Stage, string> = {
  planning: "Planning",
  implementation: "Implementation",
  testing: "Testing",
  review: "Review",
  merge: "Merge",
};

/**
 * Session phases ralph-loop.sh writes, by the stage they evidence. `red` writes the failing tests
 * first; `green`, `refactor` and `docs` complete the slice; every `review-*` session belongs to a
 * review round. `lead` is deliberately absent: one Lead session spans all stages.
 */
export const PHASE_STAGE: Readonly<Record<string, Stage>> = {
  red: "testing",
  green: "implementation",
  refactor: "implementation",
  docs: "implementation",
  "review-spec": "review",
  "review-standards": "review",
  "review-fix": "review",
};

export interface StageView {
  stage: Stage;
  state: StageState;
  sessions: Session[];
  /** Why the stage shows this state: the evidence, or the reason there is none. */
  note: string;
}

export interface PipelineView {
  runId: string;
  ticket: string;
  liveness: RunView["liveness"];
  stages: StageView[];
  /** Sessions whose phase maps to no stage (a Lead session, an unknown label). */
  unmapped: Session[];
}

const FAILED_SESSION: readonly string[] = ["failed", "timed-out", "interrupted"];

function sessionStageState(session: Session, liveness: RunView["liveness"]): StageState {
  if (session.status === "running") {
    if (liveness === "live") {
      return "active";
    }
    // A `running` record in a quiet or finished run: the session was cut off without finishing.
    return liveness === "stale" ? "stale" : "unknown";
  }
  if (session.status === "ok") {
    return "completed";
  }
  return FAILED_SESSION.includes(session.status) ? "failed" : "unknown";
}

function sessionStage(stage: Stage, sessions: Session[], run: RunView): StageView {
  const last = sessions.at(-1);
  if (last === undefined) {
    return { stage, state: "unknown", sessions, note: "no session recorded in this run" };
  }
  const state = sessionStageState(last, run.liveness);
  return { stage, state, sessions, note: `latest: ${last.label} ${last.status}` };
}

function reviewStage(stage: StageView, reviews: ReviewView[]): StageView {
  const latest = reviews.find((review) => review.kind === "loop");
  if (latest === undefined) {
    return stage;
  }
  const round = latest.round === null ? "" : ` round ${latest.round}`;
  return { ...stage, note: `${stage.note}; review${round}: ${latest.decision.verdict}` };
}

function mergeStage(
  run: RunView,
  ticket: TicketView | undefined,
  reviews: ReviewView[],
): StageView {
  const base = { stage: "merge" as const, sessions: [] };
  if (ticket?.completion?.run === run.runId) {
    return {
      ...base,
      state: "completed",
      note: `completion record: ${ticket.completion.branch} on ${ticket.completion.date}`,
    };
  }
  const host = reviews.find((review) => review.kind === "host");
  if (host !== undefined && host.decision.verdict !== "approved") {
    return { ...base, state: "failed", note: `host review: ${host.decision.verdict}` };
  }
  return { ...base, state: "unknown", note: "no merge recorded for this run" };
}

export function pipelineFor(
  run: RunView,
  ticketNumber: string,
  ticket: TicketView | undefined,
  reviews: ReviewView[],
): PipelineView {
  const sessions = run.sessions.filter((session) => session.ticket === ticketNumber);
  const own = reviews.filter(
    (review) => review.run === run.runId && ticket !== undefined && review.slug === ticket.slug,
  );
  const inStage = (stage: Stage) => sessions.filter((s) => PHASE_STAGE[s.phase] === stage);
  const stages: StageView[] = [
    {
      stage: "planning",
      state: "unknown",
      sessions: [],
      note: "not recorded: Ralph writes no planning artifact",
    },
    sessionStage("implementation", inStage("implementation"), run),
    sessionStage("testing", inStage("testing"), run),
    reviewStage(sessionStage("review", inStage("review"), run), own),
    mergeStage(run, ticket, own),
  ];
  return {
    runId: run.runId,
    ticket: ticketNumber,
    liveness: run.liveness,
    stages,
    unmapped: sessions.filter((s) => PHASE_STAGE[s.phase] === undefined),
  };
}

/** One pipeline per ticket the run worked on, in the order the run first touched them. */
export function pipelinesOf(run: RunView, state: DashboardState): PipelineView[] {
  const tickets = new Map((state.tickets ?? []).map((t) => [t.number, t]));
  return run.tickets.map((number) => pipelineFor(run, number, tickets.get(number), state.reviews));
}

export type ExecutionKind = "live" | "stale" | "idle" | "unknown";

/**
 * `live` while at least one run is active and recently written. Otherwise `unknown`, with the
 * reason, when the run list could not be fully read (a run nobody could list may be the live one),
 * an active run's files could not all be listed (it may be writing them), or a run that may still
 * be working has no usable run.json. Then `stale` when runs only claim to be active, and `idle`
 * when no run claims to be active at all.
 */
export function executionStatus(state: DashboardState): {
  kind: ExecutionKind;
  runs: RunView[];
  reason: string | null;
} {
  const runs = state.current.runs;
  if (runs.some((run) => run.liveness === "live")) {
    return { kind: "live", runs, reason: null };
  }
  const unchecked = runs.find((run) => run.liveness === "unknown");
  const reason =
    state.runsIncomplete ??
    (unchecked
      ? `run ${unchecked.runId}: ${unchecked.statusProblem ?? unchecked.sessionsIncomplete ?? "activity unknown"}`
      : null);
  if (reason !== null) {
    return { kind: "unknown", runs, reason };
  }
  return { kind: runs.length > 0 ? "stale" : "idle", runs, reason: null };
}

/**
 * Why a review of this kind may be missing for the run or ticket slug given; null when every
 * review that could apply was read. A gap with no run or slug covers all of them.
 */
export function reviewsUncertain(
  state: DashboardState,
  scope: { kind: "loop" | "host"; run?: string; slug?: string },
): string | null {
  const gap = state.reviewGaps.find(
    (g) =>
      g.kind === scope.kind &&
      (scope.run === undefined || g.run === null || g.run === scope.run) &&
      (scope.slug === undefined || g.slug === null || g.slug === scope.slug),
  );
  return gap?.reason ?? null;
}

/** Why a ticket's latest agent phase may be missing: some run or session list is incomplete. */
export function phasesUncertain(state: DashboardState): string | null {
  if (state.runsIncomplete !== null) {
    return state.runsIncomplete;
  }
  const run = state.runs.find((r) => r.sessionsIncomplete !== null);
  return run ? `run ${run.runId}: ${run.sessionsIncomplete}` : null;
}

const time = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

/**
 * From the first recorded start to run.json's finish, else the last finished session; a live run
 * runs until now. Null when the artifacts carry no usable times.
 */
export function runDurationMs(run: RunView, now: number): number | null {
  const start = time(run.startedAt);
  // Without sessions the only times are run.json's, and a host-imported run.json is written at
  // import with start == finish: a duration from it would be a fabricated 0s.
  if (start === null || run.sessions.length === 0) {
    return null;
  }
  const lastFinished = [...run.sessions].reverse().find((s) => s.finished !== null);
  const end =
    time(run.finishedAt) ?? (run.liveness === "live" ? now : time(lastFinished?.finished ?? null));
  return end === null || end < start ? null : end - start;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "unknown";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** What a run's outcome badge says: run.json's status, qualified by liveness. */
export function runOutcome(run: RunView): string {
  if (run.liveness === "live") {
    return "running";
  }
  if (run.liveness === "stale") {
    return "stale";
  }
  // An active run whose files could not all be listed: neither running, stale nor finished.
  return run.liveness === "unknown" ? "unknown" : (run.status ?? "unknown");
}

export interface RunSummary {
  run: RunView;
  durationMs: number | null;
  outcome: string;
  reviews: ReviewView[];
  failures: FailureView[];
  /** Blocking findings of every rejecting review in this run: the reasons it was turned back. */
  rejections: string[];
}

export function summarizeRun(run: RunView, state: DashboardState, now: number): RunSummary {
  const reviews = state.reviews.filter((review) => review.run === run.runId);
  const rejections = reviews
    .filter((review) => review.decision.verdict !== "approved")
    .flatMap((review) =>
      review.decision.blockers.map(
        (b) => `${review.slug.slice(0, 2)} [${b.severity}] ${b.axis}: ${b.title}`,
      ),
    );
  return {
    run,
    durationMs: runDurationMs(run, now),
    outcome: runOutcome(run),
    reviews,
    failures: state.failures.filter((failure) => failure.source === `run ${run.runId}`),
    rejections,
  };
}

// ---------------------------------------------------------------------------------------------
// Activity

export type Tone = "ok" | "bad" | "live" | "warn" | "muted";

export interface ActivityItem {
  at: string;
  tone: Tone;
  title: string;
  detail: string;
}

const SESSION_TONE: Record<(typeof SESSION_STATUSES)[number], Tone> = {
  running: "live",
  ok: "ok",
  failed: "bad",
  "timed-out": "bad",
  interrupted: "bad",
};

const sessionTone = (status: string): Tone =>
  (SESSION_TONE as Record<string, Tone | undefined>)[status] ?? "muted";

const ACTIVITY_RUNS = 5;

/** Why the activity feed may lack events; null when every source behind it was read. */
export function activityIncomplete(state: DashboardState): string | null {
  const run = state.runs.slice(0, ACTIVITY_RUNS).find((r) => r.sessionsIncomplete !== null);
  return (
    state.runsIncomplete ??
    state.failuresIncomplete ??
    (run ? `run ${run.runId}: ${run.sessionsIncomplete}` : null)
  );
}

/** Newest first: sessions of the most recent runs, and recorded failures. Only timed events. */
export function recentActivity(state: DashboardState, limit: number): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const run of state.runs.slice(0, ACTIVITY_RUNS)) {
    for (const session of run.sessions) {
      items.push({
        at: session.finished ?? session.started,
        tone: sessionTone(session.status),
        title: `${session.label} ${session.status}`,
        detail: `run ${run.runId}`,
      });
    }
  }
  for (const failure of state.failures) {
    items.push({ at: failure.at, tone: "bad", title: failure.kind, detail: failure.detail });
  }
  return items
    .filter((item) => time(item.at) !== null)
    .sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Technical debt

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export const DEBT_STATUSES = ["OPEN", "PLANNED", "RESOLVED"] as const;

export interface DebtCounts {
  open: number;
  planned: number;
  resolved: number;
  /** Entries whose status is none of the three the register defines. */
  other: number;
}

export function debtCounts(entries: DebtEntry[]): DebtCounts {
  const counts: DebtCounts = { open: 0, planned: 0, resolved: 0, other: 0 };
  for (const entry of entries) {
    if (entry.status === "OPEN") {
      counts.open += 1;
    } else if (entry.status === "PLANNED") {
      counts.planned += 1;
    } else if (entry.status === "RESOLVED") {
      counts.resolved += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

export interface SeverityRow {
  severity: string;
  open: number;
  planned: number;
  resolved: number;
  total: number;
}

/** One row per register severity, plus one for any severity value the register does not define. */
export function severityDistribution(entries: DebtEntry[]): SeverityRow[] {
  const known: readonly string[] = SEVERITIES;
  const extra = [...new Set(entries.map((e) => e.severity).filter((s) => !known.includes(s)))];
  return [...SEVERITIES, ...extra].map((severity) => {
    const own = debtCounts(entries.filter((entry) => entry.severity === severity));
    return {
      severity,
      open: own.open,
      planned: own.planned,
      resolved: own.resolved,
      total: own.open + own.planned + own.resolved + own.other,
    };
  });
}

export interface ActionableDebt {
  entry: DebtEntry;
  /** Unfinished tickets whose debt-gate verdict names this entry right now. */
  holding: string[];
}

const rank = (severity: string): number => {
  const index = (SEVERITIES as readonly string[]).indexOf(severity);
  return index === -1 ? SEVERITIES.length : index;
};

/**
 * Unresolved entries, most actionable first: those the gate cites against a ticket now, then by
 * severity, then untriaged (`OPEN`) before planned, then by id. The gate's own reasons decide
 * "holding", so this never claims a block the gate did not report.
 */
export function prioritizedDebt(
  entries: DebtEntry[],
  held: { ticket: string; verdict: DebtVerdict }[],
): ActionableDebt[] {
  const cites = (id: string, reason: string) => reason.split(/[\s,:;()]+/).includes(id);
  return entries
    .filter((entry) => entry.status !== "RESOLVED")
    .map((entry) => ({
      entry,
      holding: held
        .filter(({ verdict }) => verdict.reasons.some((reason) => cites(entry.id, reason)))
        .map(({ ticket }) => ticket),
    }))
    .sort(
      (a, b) =>
        Number(b.holding.length > 0) - Number(a.holding.length > 0) ||
        rank(a.entry.severity) - rank(b.entry.severity) ||
        Number(b.entry.status === "OPEN") - Number(a.entry.status === "OPEN") ||
        a.entry.id.localeCompare(b.entry.id),
    );
}
