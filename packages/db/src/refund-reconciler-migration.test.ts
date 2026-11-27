import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupEmptyTestDatabase } from "@ticketarena/test-infra";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Before this migration a refund request's reason and correlation id lived only in its outbox
// row. The database stops at the last migration before the reconciler's, gets open and closed
// obligations (some whose request is gone), and then takes every later migration in name order,
// as `prisma migrate deploy` would.
const database = setupEmptyTestDatabase();
const MIGRATIONS = resolve(__dirname, "../prisma/migrations");
const LAST_BEFORE_RECONCILER = "20261127000000_orphan_refund_obligations";

const AT = "2027-03-01T12:04:00.000Z";
const CORRELATION = "70000000-0000-4000-8000-000000000001";
const ids = {
  venue: "10000000-0000-4000-8000-000000000001",
  event: "20000000-0000-4000-8000-000000000001",
  expiredHold: "30000000-0000-4000-8000-000000000001",
  cancelledHold: "30000000-0000-4000-8000-000000000002",
  expiredOrder: "50000000-0000-4000-8000-000000000001",
  cancelledOrder: "50000000-0000-4000-8000-000000000002",
  /** REFUND_REQUESTED with its `late_delivery` request still in the outbox. */
  requested: "40000000-0000-4000-8000-000000000001",
  /** MANUAL_REVIEW on a cancelled order whose request retention already deleted. */
  review: "40000000-0000-4000-8000-000000000002",
  applied: "40000000-0000-4000-8000-000000000003",
  /** An orphan obligation whose request is in the outbox with its correlation id. */
  orphan: "40000000-0000-4000-8000-000000000004",
  /** An orphan obligation whose request carries no correlation id (as the backfill's test rows). */
  bareOrphan: "40000000-0000-4000-8000-000000000005",
};

let client: pg.Client;

function migrations(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function apply(names: readonly string[]): Promise<void> {
  for (const name of names) {
    await client.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
  }
}

async function order(orderId: string, holdId: string, status: string): Promise<void> {
  await client.query(
    `INSERT INTO holds (id, "eventId", "sessionId", "buyerKey", status, "holdExpiresAt", "correlationId")
     VALUES ($1, $2, 's', 'b', 'ORDERED', $3, $4)`,
    [holdId, ids.event, AT, CORRELATION],
  );
  await client.query(
    `INSERT INTO orders (id, "holdId", "sessionId", "buyerKey", "contactEmail", "totalMinor",
       currency, status, "paymentDeadline", "idempotencyKey", "requestHash", "correlationId", "createdAt")
     VALUES ($1, $2, 's', 'b', 'a@example.com', 1000, 'EUR', $3, $4, $6, 'h', $5, $4)`,
    [orderId, holdId, status, AT, CORRELATION, `key-${orderId}`],
  );
}

async function payment(paymentId: string, orderId: string, disposition: string): Promise<void> {
  await client.query(
    `INSERT INTO order_payments ("paymentId", "orderId", amount, currency, "capturedAt", disposition,
       "refundRequestedAt")
     VALUES ($1, $2, 1000, 'EUR', $3, $4, $5)`,
    [paymentId, orderId, AT, disposition, disposition === "APPLIED" ? null : AT],
  );
}

async function request(paymentId: string, envelope: object): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (id, "aggregateType", "aggregateId", "eventType", payload, "createdAt")
     VALUES (gen_random_uuid(), 'order_payment', $1, 'payment.refund_requested', $2::jsonb, $3)`,
    [paymentId, JSON.stringify(envelope), AT],
  );
}

async function seed(): Promise<void> {
  await client.query(`INSERT INTO venues (id, name) VALUES ($1, 'Arena')`, [ids.venue]);
  await client.query(
    `INSERT INTO events (id, "venueId", name, "onSaleAt", "queueOpensAt", "queueClosesAt")
     VALUES ($1, $2, 'Show', $3, $3, $3)`,
    [ids.event, ids.venue, AT],
  );
  await order(ids.expiredOrder, ids.expiredHold, "EXPIRED");
  await order(ids.cancelledOrder, ids.cancelledHold, "CANCELLED");
  await payment(ids.requested, ids.expiredOrder, "REFUND_REQUESTED");
  await payment(ids.review, ids.cancelledOrder, "MANUAL_REVIEW");
  await payment(ids.applied, ids.expiredOrder, "APPLIED");
  await request(ids.requested, {
    correlationId: CORRELATION,
    payload: { paymentId: ids.requested, reason: "late_delivery" },
  });
  for (const paymentId of [ids.orphan, ids.bareOrphan]) {
    await client.query(
      `INSERT INTO orphan_refund_obligations
         ("paymentId", "orderId", amount, currency, "capturedAt", status, "refundRequestedAt")
       VALUES ($1, gen_random_uuid(), 1000, 'EUR', $2, 'REFUND_REQUESTED', $2)`,
      [paymentId, AT],
    );
  }
  await request(ids.orphan, {
    correlationId: CORRELATION,
    payload: { paymentId: ids.orphan, reason: "unknown_order" },
  });
  await request(ids.bareOrphan, {
    payload: { paymentId: ids.bareOrphan, reason: "unknown_order" },
  });
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  const all = migrations();
  const cut = all.indexOf(LAST_BEFORE_RECONCILER) + 1;
  expect(cut).toBeGreaterThan(0);
  await apply(all.slice(0, cut));
  await seed();
  await apply(all.slice(cut));
});

afterAll(async () => {
  await client.end();
});

describe("the refund reconciler migration on a database with refund obligations", () => {
  it("gives every ledger obligation its request's reason, or its order's, and its first request as its last", async () => {
    const { rows } = await client.query(
      `SELECT "paymentId", disposition, "refundReason", "refundAttempts", "refundLastRequestedAt"
       FROM order_payments ORDER BY "paymentId"`,
    );

    expect(rows).toEqual([
      {
        paymentId: ids.requested,
        disposition: "REFUND_REQUESTED",
        refundReason: "late_delivery",
        refundAttempts: 0,
        refundLastRequestedAt: new Date(AT),
      },
      {
        paymentId: ids.review,
        disposition: "MANUAL_REVIEW",
        refundReason: "order_cancelled",
        refundAttempts: 0,
        refundLastRequestedAt: new Date(AT),
      },
      {
        paymentId: ids.applied,
        disposition: "APPLIED",
        refundReason: null,
        refundAttempts: 0,
        refundLastRequestedAt: null,
      },
    ]);
  });

  it("gives every orphan obligation its request's correlation id, or its payment id, and no re-emits yet", async () => {
    const { rows } = await client.query(
      `SELECT "paymentId", "correlationId", "refundAttempts", "refundLastRequestedAt"
       FROM orphan_refund_obligations ORDER BY "paymentId"`,
    );

    expect(rows).toEqual([
      {
        paymentId: ids.orphan,
        correlationId: CORRELATION,
        refundAttempts: 0,
        refundLastRequestedAt: new Date(AT),
      },
      {
        paymentId: ids.bareOrphan,
        correlationId: ids.bareOrphan,
        refundAttempts: 0,
        refundLastRequestedAt: new Date(AT),
      },
    ]);
  });

  // The migration runs while the old worker still runs, and a rollback runs it again on this
  // schema: its writes must keep succeeding until a later contract migration (deployment.md).
  it("accepts the old worker's ledger refund obligation, written without a reason or a last request", async () => {
    const paymentId = "40000000-0000-4000-8000-000000000006";
    await client.query(
      `INSERT INTO order_payments ("paymentId", "orderId", amount, currency, "capturedAt", disposition,
         "refundRequestedAt")
       VALUES ($1, $2, 1000, 'EUR', $3, 'REFUND_REQUESTED', $3)`,
      [paymentId, ids.cancelledOrder, AT],
    );

    const { rows } = await client.query(
      `SELECT disposition, "refundReason", "refundLastRequestedAt" FROM order_payments
       WHERE "paymentId" = $1`,
      [paymentId],
    );
    expect(rows).toEqual([
      { disposition: "REFUND_REQUESTED", refundReason: null, refundLastRequestedAt: null },
    ]);
  });

  it("after a rollback, keeps the old worker's writes working: APPLIED rows, and closing a row the new worker wrote", async () => {
    const applied = "40000000-0000-4000-8000-000000000007";
    const newShape = "40000000-0000-4000-8000-000000000008";
    await client.query(
      `INSERT INTO order_payments ("paymentId", "orderId", amount, currency, "capturedAt", disposition)
       VALUES ($1, $2, 1000, 'EUR', $3, 'APPLIED')`,
      [applied, ids.cancelledOrder, AT],
    );
    await client.query(
      `INSERT INTO order_payments ("paymentId", "orderId", amount, currency, "capturedAt", disposition,
         "refundRequestedAt", "refundReason", "refundLastRequestedAt")
       VALUES ($1, $2, 1000, 'EUR', $3, 'REFUND_REQUESTED', $3, 'order_expired', $3)`,
      [newShape, ids.expiredOrder, AT],
    );

    // The old saga's payment.refunded update, as on main.
    const closed = await client.query(
      `UPDATE order_payments SET disposition = 'REFUNDED'
       WHERE "paymentId" = $1 AND disposition IN ('REFUND_REQUESTED', 'MANUAL_REVIEW')`,
      [newShape],
    );
    expect(closed.rowCount).toBe(1);
    // Its own refund obligation, beside the new worker's rows.
    await client.query(
      `INSERT INTO order_payments ("paymentId", "orderId", amount, currency, "capturedAt", disposition,
         "refundRequestedAt")
       VALUES ('40000000-0000-4000-8000-00000000000a', $1, 1000, 'EUR', $2, 'REFUND_REQUESTED', $2)`,
      [ids.expiredOrder, AT],
    );
    // The old saga's unknown_order refund: an outbox row only, which the reconciler catches up.
    await request("40000000-0000-4000-8000-000000000009", {
      correlationId: CORRELATION,
      payload: { paymentId: "40000000-0000-4000-8000-000000000009", reason: "unknown_order" },
    });
  });
});
