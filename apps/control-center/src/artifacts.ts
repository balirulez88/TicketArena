// Parsers for the harness's run artifacts. Each takes the file's text and returns either a value
// or the reason the file is unusable; none of them throws, because one corrupt artifact must not
// take the whole page down, and none of them fills in a value the file does not contain.

import { z } from "zod";
import type {
  BatchState,
  LockOwner,
  Parsed,
  PauseState,
  ReviewDecision,
  RunRecord,
  SandboxVerdict,
  Session,
} from "./model";
import { SESSION_STATUSES } from "./model";

const fail = (reason: string): Parsed<never> => ({ ok: false, reason });

function parseJson<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    return fail(`unexpected shape at \`${issue?.path.join(".") || "(root)"}\`: ${issue?.message}`);
  }
  return { ok: true, value: result.data };
}

const nullableString = z.string().nullable().optional();

// scripts/ralph-artifacts.mjs `markRun`.
const runSchema = z.object({
  run_id: z.string(),
  status: z.string(),
  started_at: nullableString,
  finished_at: nullableString,
});

export function parseRunJson(text: string): Parsed<RunRecord> {
  const parsed = parseJson(text, runSchema);
  return parsed.ok
    ? {
        ok: true,
        value: {
          runId: parsed.value.run_id,
          status: parsed.value.status,
          startedAt: parsed.value.started_at ?? null,
          finishedAt: parsed.value.finished_at ?? null,
        },
      }
    : parsed;
}

/**
 * Session labels are `<NN> <phase>[#<attempt>]` (ralph-loop.sh: `12 red#1`, `12 review-spec`,
 * `54 lead`). A label in any other shape keeps its full text as the phase.
 */
export function parseSessionLabel(label: string): {
  ticket: string | null;
  phase: string;
  attempt: number | null;
} {
  const match = /^(\d{2}) ([a-z][a-z-]*)(?:#(\d+))?$/.exec(label.trim());
  if (!match) {
    return { ticket: null, phase: label.trim(), attempt: null };
  }
  const [, ticket = null, phase = label, attempt] = match;
  return { ticket, phase, attempt: attempt === undefined ? null : Number(attempt) };
}

/**
 * Session records: `sessions.tsv` (merged at run end, with a header) and the per-process
 * `sessions/*.tsv` records (no header). Columns: started, label, session, status, exit, finished.
 */
export function parseSessionsTsv(text: string): Parsed<Session[]> {
  const sessions: Session[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" || line.startsWith("started\t")) {
      continue;
    }
    const columns = line.split("\t");
    if (columns.length !== 6) {
      return fail(`line ${index + 1} has ${columns.length} columns, expected 6`);
    }
    const [started = "", label = "", session = "", status = "", exit = "", finished = ""] = columns;
    sessions.push({
      started,
      ...parseSessionLabel(label),
      label,
      session,
      status,
      statusRecognized: (SESSION_STATUSES as readonly string[]).includes(status),
      exit,
      finished: finished === "-" || finished === "" ? null : finished,
    });
  }
  return { ok: true, value: sessions };
}

// scripts/ralph-review.mjs: `<slug>.review-<round>.decision.json` and the host review's
// `decision.json`.
const decisionSchema = z.object({
  verdict: z.string(),
  blockers: z
    .array(z.object({ axis: z.string(), severity: z.string(), title: z.string() }))
    .optional(),
  findings: z.array(z.object({ severity: z.string() })).optional(),
  errors: z.record(z.string(), z.array(z.unknown())).optional(),
});

export function parseDecision(text: string): Parsed<ReviewDecision> {
  const parsed = parseJson(text, decisionSchema);
  if (!parsed.ok) {
    return parsed;
  }
  const findings: Record<string, number> = {};
  for (const finding of parsed.value.findings ?? []) {
    findings[finding.severity] = (findings[finding.severity] ?? 0) + 1;
  }
  const errors = Object.values(parsed.value.errors ?? {}).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  return {
    ok: true,
    value: {
      verdict: parsed.value.verdict,
      blockers: parsed.value.blockers ?? [],
      findings,
      errors,
    },
  };
}

// scripts/ralph-accept.mjs writes `.ralph/sandbox/<run>/verdict.json` when the host has decided.
const verdictSchema = z.object({
  exit: z.number().int(),
  outcome: z.string(),
  reason: z.string().optional(),
});

export function parseSandboxVerdict(text: string): Parsed<SandboxVerdict> {
  const parsed = parseJson(text, verdictSchema);
  return parsed.ok
    ? { ok: true, value: { ...parsed.value, reason: parsed.value.reason ?? null } }
    : parsed;
}

// scripts/ralph-batch.mjs `.ralph/batch/state.json`.
const batchSchema = z.object({
  batch: z.string(),
  status: z.string(),
  max_tickets: z.number().int().nullable().optional(),
  stop: z
    .object({ reason: z.string(), detail: z.string().optional(), at: z.string().optional() })
    .nullable()
    .optional(),
  tickets: z.array(z.object({ number: z.string(), slug: z.string(), stage: z.string() })),
  updated_at: nullableString,
});

export function parseBatchState(text: string): Parsed<BatchState> {
  const parsed = parseJson(text, batchSchema);
  if (!parsed.ok) {
    return parsed;
  }
  const { stop } = parsed.value;
  return {
    ok: true,
    value: {
      batch: parsed.value.batch,
      status: parsed.value.status,
      maxTickets: parsed.value.max_tickets ?? null,
      stop: stop ? { reason: stop.reason, detail: stop.detail ?? "", at: stop.at ?? "" } : null,
      tickets: parsed.value.tickets,
      updatedAt: parsed.value.updated_at ?? null,
    },
  };
}

// `.ralph/batch/lock/owner.json`. The lock is held even when the owner file is unreadable
// (scripts/ralph-batch.mjs `acquireLock`), so an unreadable owner is reported as unknown.
const ownerSchema = z.object({
  pid: z.number().int().optional(),
  host: z.string().optional(),
  started_at: z.string().optional(),
});

export function parseLockOwner(text: string): Parsed<LockOwner> {
  const parsed = parseJson(text, ownerSchema);
  return parsed.ok
    ? {
        ok: true,
        value: {
          pid: parsed.value.pid ?? null,
          host: parsed.value.host ?? null,
          startedAt: parsed.value.started_at ?? null,
        },
      }
    : parsed;
}

const PAUSE_KEYS = ["ticket", "phase", "attempt", "round", "reason", "run", "ref"] as const;

/** `.ralph/state/<slug>.pause`: `key=value` lines written when a provider failure pauses a run. */
export function parsePause(text: string): Parsed<PauseState> {
  const values = new Map<string, string>();
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) {
      values.set(line.slice(0, index), line.slice(index + 1));
    }
  }
  const missing = PAUSE_KEYS.filter((key) => !values.has(key));
  if (missing.length > 0) {
    return fail(`missing ${missing.join(", ")}`);
  }
  const get = (key: (typeof PAUSE_KEYS)[number]): string => values.get(key) ?? "";
  return {
    ok: true,
    value: {
      ticket: get("ticket"),
      phase: get("phase"),
      attempt: get("attempt"),
      round: get("round"),
      reason: get("reason"),
      run: get("run"),
      ref: get("ref"),
    },
  };
}
