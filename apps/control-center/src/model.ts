// The dashboard's vocabulary. Every value shown on the page carries where it came from and how
// fresh it is, so a reader never mistakes a stale artifact, or a gap, for the harness's state.

/**
 * - `live`: a source that describes the present: the ticket files on the ref and the debt gate
 *   computed from them, or a run artifact that claims to be in progress and changed recently.
 * - `historical`: a record of something that finished (a run, a review round, a verdict).
 * - `unavailable`: the source is missing or could not be parsed; the reason says which.
 */
export type Provenance = "live" | "historical" | "unavailable";

/** Ticket statuses defined by issues/README.md. Anything else is shown verbatim as unrecognized. */
export const TICKET_STATUSES = [
  "ready-for-agent",
  "in-progress",
  "done",
  "blocked",
  "ready-for-human",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type TicketLocation = "active" | "done";

export interface Completion {
  date: string;
  branch: string;
  run: string;
}

export interface Ticket {
  number: string;
  slug: string;
  title: string;
  /** The `**Status:**` value exactly as written; empty when the line is missing. */
  status: string;
  statusRecognized: boolean;
  blockedBy: string[];
  location: TicketLocation;
  completion: Completion | null;
  criteria: { total: number; checked: number };
  /** Contract violations found while parsing, e.g. a missing status line. */
  problems: string[];
}

/** Session statuses written by ralph-loop.sh (`fresh_session`). */
export const SESSION_STATUSES = ["running", "ok", "failed", "timed-out", "interrupted"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Session {
  started: string;
  ticket: string | null;
  /** Phase name from the label (`red`, `green`, `review-spec`, `lead`, ...), verbatim. */
  phase: string;
  attempt: number | null;
  label: string;
  session: string;
  /** Verbatim; `statusRecognized` is false for values ralph-loop.sh does not write. */
  status: string;
  statusRecognized: boolean;
  exit: string;
  finished: string | null;
}

/** `run.json` statuses written by scripts/ralph-artifacts.mjs. */
export const RUN_STATUSES = ["active", "succeeded", "failed", "paused"] as const;

export interface RunRecord {
  runId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReviewDecision {
  verdict: string;
  blockers: { axis: string; severity: string; title: string }[];
  findings: Record<string, number>;
  errors: number;
}

export interface SandboxVerdict {
  exit: number;
  outcome: string;
  reason: string | null;
}

export interface BatchTicket {
  number: string;
  slug: string;
  stage: string;
}

export interface BatchState {
  batch: string;
  status: string;
  maxTickets: number | null;
  stop: { reason: string; detail: string; at: string } | null;
  tickets: BatchTicket[];
  updatedAt: string | null;
}

export interface LockOwner {
  pid: number | null;
  host: string | null;
  startedAt: string | null;
}

export interface PauseState {
  ticket: string;
  phase: string;
  attempt: string;
  round: string;
  reason: string;
  run: string;
  ref: string;
}

export interface GitBranch {
  name: string;
  sha: string;
  date: string;
  subject: string;
}

/** A source the dashboard tried to read and could not use. */
export interface Gap {
  source: string;
  reason: string;
}

/** Result of parsing one artifact: either a value, or the reason it is unusable. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };
