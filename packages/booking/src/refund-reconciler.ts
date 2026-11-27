import {
  envelopeLogBindings,
  envelopeSchema,
  type Logger,
  paymentRefundRequestedPayloadSchema,
} from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import type { Clock } from "./booking-service";

/**
 * The reconciler's limits (spec: Refund obligations and reconciliation). Injectable so tests and
 * operations can change them; the production values are `DEFAULT_REFUND_RECONCILER_LIMITS`.
 */
export interface RefundReconcilerLimits {
  /** An obligation is stale once its last request is at least this old. Must be positive. */
  readonly staleAfterMs: number;
  /** Re-emits before a stale obligation moves to `MANUAL_REVIEW` instead. */
  readonly maxReEmits: number;
  /** Obligations claimed per transaction; a pass repeats batches until a short one. */
  readonly batchSize: number;
}

export const DEFAULT_REFUND_RECONCILER_LIMITS: RefundReconcilerLimits = {
  staleAfterMs: 10 * 60_000,
  maxReEmits: 3,
  batchSize: 100,
};

/** What one reconciler pass did, by payment id. */
export interface ReconcileResult {
  readonly reEmitted: readonly string[];
  readonly escalated: readonly string[];
}

export type RefundObligationStatus = "REFUND_REQUESTED" | "MANUAL_REVIEW" | "REFUNDED";

/** A refund obligation, from the ledger or an orphan one: the same shape either way. */
export interface RefundObligationView {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: RefundObligationStatus;
  readonly refundAttempts: number;
  /** The first request; the obligation's age is measured from it. */
  readonly refundRequestedAt: Date;
  /** The latest request (first request, re-emit or retry); staleness is measured from it. */
  readonly refundLastRequestedAt: Date;
}

/** No refund obligation, in the ledger or orphaned, exists for the payment. */
export class RefundObligationNotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(paymentId: string) {
    super(`NOT_FOUND: no refund obligation for payment ${paymentId}`);
    this.name = "RefundObligationNotFoundError";
  }
}

/** Only an obligation in `MANUAL_REVIEW` can be retried; nothing changed. */
export class RefundNotInManualReviewError extends Error {
  readonly code = "REFUND_NOT_IN_MANUAL_REVIEW";

  constructor(
    paymentId: string,
    readonly status: string,
  ) {
    super(`REFUND_NOT_IN_MANUAL_REVIEW: payment ${paymentId} is ${status}`);
    this.name = "RefundNotInManualReviewError";
  }
}

export interface RefundReconciler {
  reconcileRefunds(): Promise<ReconcileResult>;
  retryRefund(paymentId: string): Promise<RefundObligationView>;
  refundPendingAgeMax(): Promise<number>;
}

interface ReconcilerDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: Logger;
  readonly limits: RefundReconcilerLimits;
}

const REFUND_REQUESTED_EVENT = "payment.refund_requested";
/** As the saga writes it: refund requests are keyed by payment. */
const REFUND_AGGREGATE = "order_payment";
const requestEnvelope = envelopeSchema(paymentRefundRequestedPayloadSchema);

/** An obligation locked for a re-emit, with everything its request carries. */
interface LockedObligation {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: RefundObligationStatus;
  readonly refundAttempts: number;
  readonly refundRequestedAt: Date;
  readonly refundLastRequestedAt: Date;
  readonly correlationId: string;
  /** `null` for an orphan: its order, and so its hold and contact, do not exist. */
  readonly holdId: string | null;
  readonly reason: string;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

/**
 * The two tables that hold refund obligations, read and changed the same way. The ledger row's
 * request facts come from its order (immutable columns, read unlocked: only the obligation row is
 * locked, so the reconciler never waits behind the saga's order lock and cannot invert its lock
 * order); an orphan obligation carries them itself.
 */
const sources = {
  ledger: {
    claimStale: (tx: TransactionClient, staleBefore: Date, limit: number) =>
      tx.$queryRaw<LockedObligation[]>`
        SELECT p."paymentId"::text AS "paymentId", p."orderId"::text AS "orderId", p.amount,
               p.currency, p.disposition::text AS status, p."refundAttempts",
               p."refundRequestedAt", p."refundLastRequestedAt",
               o."correlationId"::text AS "correlationId", o."holdId"::text AS "holdId",
               p."refundReason"::text AS reason, o."contactEmail", o."contactPhone"
        FROM order_payments p JOIN orders o ON o.id = p."orderId"
        WHERE p.disposition = 'REFUND_REQUESTED' AND p."refundLastRequestedAt" <= ${staleBefore}
        ORDER BY p."paymentId"
        LIMIT ${limit}
        FOR UPDATE OF p SKIP LOCKED`,
    lockOne: (tx: TransactionClient, paymentId: string) =>
      tx.$queryRaw<LockedObligation[]>`
        SELECT p."paymentId"::text AS "paymentId", p."orderId"::text AS "orderId", p.amount,
               p.currency, p.disposition::text AS status, p."refundAttempts",
               p."refundRequestedAt", p."refundLastRequestedAt",
               o."correlationId"::text AS "correlationId", o."holdId"::text AS "holdId",
               p."refundReason"::text AS reason, o."contactEmail", o."contactPhone"
        FROM order_payments p JOIN orders o ON o.id = p."orderId"
        WHERE p."paymentId" = ${paymentId}::uuid AND p.disposition <> 'APPLIED'
        FOR UPDATE OF p`,
    async markRequested(
      tx: TransactionClient,
      paymentIds: string[],
      T: Date,
      attempts: "next" | 0,
    ) {
      await tx.orderPayment.updateMany({
        where: { paymentId: { in: paymentIds } },
        data: {
          disposition: "REFUND_REQUESTED",
          refundAttempts: attempts === "next" ? { increment: 1 } : 0,
          refundLastRequestedAt: T,
        },
      });
    },
    async escalate(tx: TransactionClient, paymentIds: string[]) {
      await tx.orderPayment.updateMany({
        where: { paymentId: { in: paymentIds } },
        data: { disposition: "MANUAL_REVIEW" },
      });
    },
  },
  orphan: {
    claimStale: (tx: TransactionClient, staleBefore: Date, limit: number) =>
      tx.$queryRaw<LockedObligation[]>`
        SELECT "paymentId"::text AS "paymentId", "orderId"::text AS "orderId", amount, currency,
               status::text AS status, "refundAttempts", "refundRequestedAt",
               "refundLastRequestedAt", "correlationId"::text AS "correlationId",
               NULL::text AS "holdId", 'unknown_order' AS reason,
               NULL::text AS "contactEmail", NULL::text AS "contactPhone"
        FROM orphan_refund_obligations
        WHERE status = 'REFUND_REQUESTED' AND "refundLastRequestedAt" <= ${staleBefore}
        ORDER BY "paymentId"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`,
    lockOne: (tx: TransactionClient, paymentId: string) =>
      tx.$queryRaw<LockedObligation[]>`
        SELECT "paymentId"::text AS "paymentId", "orderId"::text AS "orderId", amount, currency,
               status::text AS status, "refundAttempts", "refundRequestedAt",
               "refundLastRequestedAt", "correlationId"::text AS "correlationId",
               NULL::text AS "holdId", 'unknown_order' AS reason,
               NULL::text AS "contactEmail", NULL::text AS "contactPhone"
        FROM orphan_refund_obligations
        WHERE "paymentId" = ${paymentId}::uuid
        FOR UPDATE`,
    async markRequested(
      tx: TransactionClient,
      paymentIds: string[],
      T: Date,
      attempts: "next" | 0,
    ) {
      await tx.orphanRefundObligation.updateMany({
        where: { paymentId: { in: paymentIds } },
        data: {
          status: "REFUND_REQUESTED",
          refundAttempts: attempts === "next" ? { increment: 1 } : 0,
          refundLastRequestedAt: T,
        },
      });
    },
    async escalate(tx: TransactionClient, paymentIds: string[]) {
      await tx.orphanRefundObligation.updateMany({
        where: { paymentId: { in: paymentIds } },
        data: { status: "MANUAL_REVIEW" },
      });
    },
  },
} as const;

type Source = (typeof sources)[keyof typeof sources];

/**
 * Cutover catch-up (docs/operations/deployment.md, "Refund cutover"): the refund migrations run
 * before this worker replaces the previous one, and an emergency rollback runs the previous one
 * again, so until the contract migration that one may still write refund obligations in its
 * shape: a ledger row without `refundReason` and `refundLastRequestedAt`, and an `unknown_order`
 * refund as its outbox row only. This completes both exactly as the migrations' backfills did, and
 * is idempotent: a row that is complete, or a payment that has an orphan obligation in any state,
 * is never touched again. It runs before the claims of every pass, so the claim never meets an
 * incomplete row (one has no `refundLastRequestedAt`, so no stale claim matches it either).
 * Removed with the contract migration.
 */
async function catchUpOldWorkerObligations(db: PrismaClient): Promise<number> {
  return db.$transaction(async (tx) => {
    const ledger = await tx.$executeRaw`
      UPDATE order_payments AS p
      SET "refundRequestedAt" = COALESCE(p."refundRequestedAt", p."capturedAt"),
          "refundLastRequestedAt" = COALESCE(p."refundLastRequestedAt", p."refundRequestedAt", p."capturedAt"),
          "refundReason" = COALESCE(
            p."refundReason",
            (SELECT (e."payload" -> 'payload' ->> 'reason')::"RefundReason"
             FROM outbox_events e
             WHERE e."eventType" = 'payment.refund_requested'
               AND e."aggregateId" = p."paymentId"::text
               AND e."payload" -> 'payload' ->> 'reason' <> 'unknown_order'
             ORDER BY e."createdAt"
             LIMIT 1),
            (SELECT CASE o.status::text
                      WHEN 'EXPIRED' THEN 'order_expired'
                      WHEN 'CANCELLED' THEN 'order_cancelled'
                      WHEN 'CONFIRMED' THEN 'order_confirmed'
                      ELSE 'amount_mismatch'
                    END::"RefundReason"
             FROM orders o WHERE o.id = p."orderId"))
      WHERE p.disposition <> 'APPLIED'
        AND (p."refundReason" IS NULL OR p."refundRequestedAt" IS NULL
             OR p."refundLastRequestedAt" IS NULL)`;
    // From the payment's earliest request: it carries no capture time, so its `occurredAt` (the
    // saga's T, never before the capture) is the historical proxy for `capturedAt`.
    const orphans = await tx.$executeRaw`
      INSERT INTO orphan_refund_obligations
        ("paymentId", "orderId", amount, currency, "capturedAt", status, "refundRequestedAt",
         "correlationId", "refundAttempts", "refundLastRequestedAt")
      SELECT DISTINCT ON (e."aggregateId")
        (e."payload" -> 'payload' ->> 'paymentId')::uuid,
        (e."payload" -> 'payload' ->> 'orderId')::uuid,
        (e."payload" -> 'payload' ->> 'amount')::integer,
        e."payload" -> 'payload' ->> 'currency',
        (e."payload" ->> 'occurredAt')::timestamptz,
        'REFUND_REQUESTED',
        (e."payload" ->> 'occurredAt')::timestamptz,
        COALESCE((e."payload" ->> 'correlationId')::uuid,
                 (e."payload" -> 'payload' ->> 'paymentId')::uuid),
        0,
        (e."payload" ->> 'occurredAt')::timestamptz
      FROM outbox_events e
      WHERE e."eventType" = 'payment.refund_requested'
        AND e."payload" -> 'payload' ->> 'reason' = 'unknown_order'
        AND NOT EXISTS (
          SELECT 1 FROM orphan_refund_obligations r WHERE r."paymentId"::text = e."aggregateId")
      ORDER BY e."aggregateId", e."createdAt"
      ON CONFLICT ("paymentId") DO NOTHING`;
    return ledger + orphans;
  });
}

/**
 * The reconciler (spec: Refund obligations and reconciliation): no refund obligation is forgotten.
 * A `REFUND_REQUESTED` obligation whose last request is `staleAfterMs` old gets the same request
 * re-emitted through the outbox, until `maxReEmits` re-emits have gone unanswered; the next time it
 * is stale it moves to `MANUAL_REVIEW` instead, from which `retryRefund` brings it back.
 */
export function createRefundReconciler({
  db,
  clock,
  newId,
  logger,
  limits,
}: ReconcilerDeps): RefundReconciler {
  // A zero age would make a row stale again the moment it is re-emitted, and a pass would never end.
  if (!(limits.staleAfterMs > 0 && limits.batchSize > 0 && limits.maxReEmits >= 0)) {
    throw new Error(
      `refund reconciler limits: staleAfterMs and batchSize must be positive, maxReEmits not negative (got ${JSON.stringify(limits)})`,
    );
  }

  /** The obligation's request, rebuilt from its row: a new event id, the original facts. */
  async function writeRequest(
    tx: TransactionClient,
    obligation: LockedObligation,
    T: Date,
  ): Promise<void> {
    const contact =
      obligation.contactEmail === null
        ? {}
        : {
            contact: {
              email: obligation.contactEmail,
              ...(obligation.contactPhone === null ? {} : { phone: obligation.contactPhone }),
            },
          };
    // Parsed, so a row that cannot make a valid request fails here and never reaches Payment.
    const envelope = requestEnvelope.parse({
      id: newId(),
      type: REFUND_REQUESTED_EVENT,
      version: 1,
      occurredAt: T.toISOString(),
      correlationId: obligation.correlationId,
      // Not caused by a message: the reconciler's clock decided it.
      causationId: null,
      ...(obligation.holdId === null ? {} : { holdId: obligation.holdId }),
      orderId: obligation.orderId,
      payload: {
        paymentId: obligation.paymentId,
        orderId: obligation.orderId,
        amount: obligation.amount,
        currency: obligation.currency,
        reason: obligation.reason,
        ...contact,
      },
    });
    await tx.outboxEvent.create({
      data: {
        id: envelope.id,
        aggregateType: REFUND_AGGREGATE,
        aggregateId: obligation.paymentId,
        eventType: REFUND_REQUESTED_EVENT,
        payload: envelope,
      },
    });
  }

  function logFor(obligation: LockedObligation): Logger {
    return logger.child(
      envelopeLogBindings({
        correlationId: obligation.correlationId,
        causationId: null,
        ...(obligation.holdId === null ? {} : { holdId: obligation.holdId }),
        orderId: obligation.orderId,
        paymentId: obligation.paymentId,
      }),
    );
  }

  /**
   * One transaction, one `T`: claims up to a batch of stale obligations and re-emits or escalates
   * each. SKIP LOCKED makes concurrent passes (two workers) split the rows instead of both taking
   * one, and never wait, so `T`, read before the claim, is not stale by a lock wait. A row this
   * pass commits no longer matches (its last request is now `T`, or it is `MANUAL_REVIEW`), so
   * a pass that claims after the commit skips it too.
   */
  async function reconcileBatch(source: Source) {
    const done = await db.$transaction(async (tx) => {
      const T = clock.now();
      const staleBefore = new Date(T.getTime() - limits.staleAfterMs);
      const claimed = await source.claimStale(tx, staleBefore, limits.batchSize);
      const escalate = claimed.filter((row) => row.refundAttempts >= limits.maxReEmits);
      const reEmit = claimed.filter((row) => row.refundAttempts < limits.maxReEmits);
      // The request and the count it bumps commit together (ADR 0003): a re-emit is never lost
      // uncounted nor counted unsent.
      for (const row of reEmit) {
        await writeRequest(tx, row, T);
      }
      if (reEmit.length > 0) {
        await source.markRequested(
          tx,
          reEmit.map((row) => row.paymentId),
          T,
          "next",
        );
      }
      if (escalate.length > 0) {
        await source.escalate(
          tx,
          escalate.map((row) => row.paymentId),
        );
      }
      return { claimed: claimed.length, reEmit, escalate };
    });
    for (const row of done.reEmit) {
      logFor(row).info({ refundAttempts: row.refundAttempts + 1 }, "refund request re-emitted");
    }
    for (const row of done.escalate) {
      // The operator's signal besides the dashboard: the money is still owed and nothing retries.
      logFor(row).warn(
        { refundAttempts: row.refundAttempts },
        "refund obligation moved to manual review",
      );
    }
    return done;
  }

  return {
    async reconcileRefunds() {
      const caughtUp = await catchUpOldWorkerObligations(db);
      if (caughtUp > 0) {
        logger.warn({ caughtUp }, "refund obligations written by the previous worker caught up");
      }
      const reEmitted: string[] = [];
      const escalated: string[] = [];
      for (const source of [sources.ledger, sources.orphan]) {
        for (;;) {
          const batch = await reconcileBatch(source);
          reEmitted.push(...batch.reEmit.map((row) => row.paymentId));
          escalated.push(...batch.escalate.map((row) => row.paymentId));
          if (batch.claimed < limits.batchSize) {
            break;
          }
        }
      }
      return { reEmitted, escalated };
    },

    async retryRefund(paymentId) {
      const retried = await db.$transaction(async (tx) => {
        // A payment id is in at most one table: the ledger if booking has its order, else orphaned.
        // An APPLIED ledger row is a payment, not a refund obligation, so it is NOT_FOUND too.
        for (const source of [sources.ledger, sources.orphan]) {
          const [row] = await source.lockOne(tx, paymentId);
          if (row === undefined) {
            continue;
          }
          if (row.status !== "MANUAL_REVIEW") {
            throw new RefundNotInManualReviewError(paymentId, row.status);
          }
          // Read after the lock: a payment.refunded that committed first has made it REFUNDED.
          const T = clock.now();
          await writeRequest(tx, row, T);
          // A fresh count: the operator's retry gets the reconciler's full re-emit budget again.
          await source.markRequested(tx, [paymentId], T, 0);
          return { row, T };
        }
        throw new RefundObligationNotFoundError(paymentId);
      });
      const { row, T } = retried;
      logFor(row).info({}, "refund retried from manual review");
      return {
        paymentId: row.paymentId,
        orderId: row.orderId,
        amount: row.amount,
        currency: row.currency,
        status: "REFUND_REQUESTED",
        refundAttempts: 0,
        refundRequestedAt: row.refundRequestedAt,
        refundLastRequestedAt: T,
      };
    },

    async refundPendingAgeMax() {
      const [oldest] = await db.$queryRaw<{ at: Date | null }[]>`
        SELECT min(at) AS at FROM (
          SELECT min("refundRequestedAt") AS at FROM order_payments
          WHERE disposition IN ('REFUND_REQUESTED', 'MANUAL_REVIEW')
          UNION ALL
          SELECT min("refundRequestedAt") FROM orphan_refund_obligations
          WHERE status IN ('REFUND_REQUESTED', 'MANUAL_REVIEW')
        ) open`;
      const at = oldest?.at ?? null;
      // A caller clock behind the clock that stamped the request reads 0, never a negative age.
      return at === null ? 0 : Math.max(0, clock.now().getTime() - at.getTime());
    },
  };
}
