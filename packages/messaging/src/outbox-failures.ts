import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import { type ServiceName, type ServiceStore, serviceStore } from "./service-store.js";

// Terminal FAILED outbox rows (ADR 0022). The three outboxes share one shape, so these run the
// same SQL against the table names of the closed ServiceName set, never against input.

/** How many permanent publish failures make a row FAILED unless the relay is given another cap. */
export const DEFAULT_MAX_PERMANENT_FAILURES = 5;

export interface OutboxHistoryEntry {
  readonly kind: "PUBLISH_FAILED" | "STATUS_CHANGED";
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  /** The row's `attempts` when the entry was written. */
  readonly attempt: number;
  readonly error: string | null;
  readonly operator: string | null;
  readonly reason: string | null;
  readonly at: Date;
}

export interface PermanentFailureOutcome {
  readonly attempts: number;
  /** True when this failure reached the cap and moved the row to FAILED. */
  readonly failed: boolean;
}

/**
 * Counts one permanent failure on a claimed (row-locked) PENDING row and appends it to the
 * history; at the cap the same statement makes the row FAILED, and the transition is appended
 * too. All in the claim transaction, so a rollback leaves neither the count nor the history.
 */
export async function recordPermanentFailure(
  tx: TransactionClient,
  store: ServiceStore,
  input: { readonly id: string; readonly error: string; readonly cap: number; readonly at: Date },
): Promise<PermanentFailureOutcome> {
  const [row] = await tx.$queryRawUnsafe<{ attempts: number; status: string }[]>(
    `UPDATE ${store.outboxTable}
     SET "attempts" = "attempts" + 1,
         "permanentFailures" = "permanentFailures" + 1,
         "lastError" = $2,
         "status" = CASE WHEN "permanentFailures" + 1 >= $3 THEN 'FAILED' ELSE "status" END,
         "failedAt" = CASE WHEN "permanentFailures" + 1 >= $3 THEN $4::timestamptz ELSE NULL END
     WHERE "id" = $1::uuid
     RETURNING "attempts", "status"::text AS "status"`,
    input.id,
    input.error,
    input.cap,
    input.at,
  );
  if (row === undefined) {
    throw new Error(`outbox row ${input.id} vanished while claimed`);
  }
  await appendHistory(tx, store, {
    outboxId: input.id,
    kind: "PUBLISH_FAILED",
    attempt: row.attempts,
    error: input.error,
    at: input.at,
  });
  const failed = row.status === "FAILED";
  if (failed) {
    await appendHistory(tx, store, {
      outboxId: input.id,
      kind: "STATUS_CHANGED",
      fromStatus: "PENDING",
      toStatus: "FAILED",
      attempt: row.attempts,
      error: input.error,
      at: input.at,
    });
  }
  return { attempts: row.attempts, failed };
}

interface HistoryInput {
  readonly outboxId: string;
  readonly kind: OutboxHistoryEntry["kind"];
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly attempt: number;
  readonly error?: string | null;
  readonly operator?: string;
  readonly reason?: string;
  readonly at: Date;
}

/** Insert only: the history is never updated or deleted, so earlier entries always survive. */
async function appendHistory(
  tx: TransactionClient,
  store: ServiceStore,
  entry: HistoryInput,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO ${store.historyTable}
       ("outboxId", "kind", "fromStatus", "toStatus", "attempt", "error", "operator", "reason", "at")
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
    entry.outboxId,
    entry.kind,
    entry.fromStatus ?? null,
    entry.toStatus ?? null,
    entry.attempt,
    entry.error ?? null,
    entry.operator ?? null,
    entry.reason ?? null,
    entry.at,
  );
}

/** The outbox row's history, oldest first; empty for a row that never failed or is unknown. */
export async function readOutboxHistory(
  db: PrismaClient | TransactionClient,
  service: ServiceName,
  outboxId: string,
): Promise<OutboxHistoryEntry[]> {
  return db.$queryRawUnsafe<OutboxHistoryEntry[]>(
    `SELECT "kind", "fromStatus", "toStatus", "attempt", "error", "operator", "reason", "at"
     FROM ${serviceStore(service).historyTable}
     WHERE "outboxId" = $1::uuid
     ORDER BY "id"`,
    outboxId,
  );
}

/** A requeue the row's state does not allow; nothing was changed. */
export class OutboxRequeueRefused extends Error {
  override readonly name = "OutboxRequeueRefused";
}

export interface RequeueInput {
  readonly service: ServiceName;
  readonly outboxId: string;
  /** Who requeues it and why; both are recorded in the row's history. */
  readonly operator: string;
  readonly reason: string;
  /** When the requeue happened; defaults to the current time. */
  readonly at?: Date;
}

/**
 * The operator's recovery of one FAILED row (runbook: docs/messaging/failed-outbox-event.md): it
 * becomes PENDING under its original id, so it is published with the same `Nats-Msg-Id` and every
 * consumer that already processed it deduplicates it. Its permanent-failure count restarts at 0.
 * Any other status, or an unknown id, is refused unchanged: a PUBLISHED row must never be sent as
 * if it were new, and a PENDING one is already on its way.
 */
export async function requeueFailedOutboxEvent(
  prisma: PrismaClient,
  input: RequeueInput,
): Promise<void> {
  if (input.operator.trim() === "" || input.reason.trim() === "") {
    throw new OutboxRequeueRefused("a requeue needs an operator and a reason");
  }
  const store = serviceStore(input.service);
  const at = input.at ?? new Date();
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ status: string; attempts: number }[]>(
      `SELECT "status"::text AS "status", "attempts" FROM ${store.outboxTable}
       WHERE "id" = $1::uuid FOR UPDATE`,
      input.outboxId,
    );
    const name = `${input.service} outbox row ${input.outboxId}`;
    if (row === undefined) {
      throw new OutboxRequeueRefused(`${name} does not exist`);
    }
    if (row.status !== "FAILED") {
      throw new OutboxRequeueRefused(
        `${name} is ${row.status}, not FAILED; only a FAILED row can be requeued`,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE ${store.outboxTable}
       SET "status" = 'PENDING', "permanentFailures" = 0, "failedAt" = NULL
       WHERE "id" = $1::uuid`,
      input.outboxId,
    );
    await appendHistory(tx, store, {
      outboxId: input.outboxId,
      kind: "STATUS_CHANGED",
      fromStatus: "FAILED",
      toStatus: "PENDING",
      attempt: row.attempts,
      operator: input.operator,
      reason: input.reason,
      at,
    });
  });
}

export interface OutboxFailureMetrics {
  /** Rows currently FAILED. */
  readonly failed: number;
  /** Age of the longest-FAILED row (since its `failedAt`), null when none is FAILED. */
  readonly oldestFailedAgeMs: number | null;
  /** Transitions to FAILED in the history, including rows since requeued. */
  readonly failedTransitions: number;
}

/** The FAILED-row health metrics of every service's outbox. */
export async function measureOutboxFailures(options: {
  readonly prisma: PrismaClient;
  readonly now: Date;
}): Promise<Record<ServiceName, OutboxFailureMetrics>> {
  const measure = async (service: ServiceName): Promise<OutboxFailureMetrics> => {
    const store = serviceStore(service);
    const [row] = await options.prisma.$queryRawUnsafe<
      { failed: number; oldest: Date | null; transitions: number }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM ${store.outboxTable} WHERE "status" = 'FAILED') AS "failed",
         (SELECT min("failedAt") FROM ${store.outboxTable} WHERE "status" = 'FAILED') AS "oldest",
         (SELECT count(*)::int FROM ${store.historyTable}
           WHERE "kind" = 'STATUS_CHANGED' AND "toStatus" = 'FAILED') AS "transitions"`,
    );
    const oldest = row?.oldest ?? null;
    return {
      failed: row?.failed ?? 0,
      oldestFailedAgeMs:
        oldest === null ? null : Math.max(0, options.now.getTime() - oldest.getTime()),
      failedTransitions: row?.transitions ?? 0,
    };
  };
  const [booking, payment, notification] = await Promise.all([
    measure("booking"),
    measure("payment"),
    measure("notification"),
  ]);
  return { booking, payment, notification };
}
