import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupEmptyTestDatabase } from "@ticketarena/test-infra";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Before this migration an unknown_order refund obligation existed only as its outbox row. The
// database stops at the last migration before the orphan table, gets such rows (one requested
// twice) plus a refund request of another reason, and then takes every later migration in name
// order, as `prisma migrate deploy` would.
const database = setupEmptyTestDatabase();
const MIGRATIONS = resolve(__dirname, "../prisma/migrations");
const LAST_BEFORE_ORPHAN_OBLIGATIONS = "20261121000000_payment_refunds";

const ORPHAN_PAYMENT = "40000000-0000-4000-8000-000000000001";
const ORPHAN_ORDER = "50000000-0000-4000-8000-000000000001";
const LEDGER_PAYMENT = "40000000-0000-4000-8000-000000000002";
const REQUESTED_AT = "2027-03-01T12:04:00.000Z";

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

function refundRequest(paymentId: string, reason: string, occurredAt: string): string {
  return JSON.stringify({
    id: "60000000-0000-4000-8000-000000000001",
    type: "payment.refund_requested",
    version: 1,
    occurredAt,
    orderId: ORPHAN_ORDER,
    payload: { paymentId, orderId: ORPHAN_ORDER, amount: 4200, currency: "EUR", reason },
  });
}

async function seedRefundRequests(): Promise<void> {
  const insert = `INSERT INTO outbox_events (id, "aggregateType", "aggregateId", "eventType", payload, "createdAt")
    VALUES (gen_random_uuid(), 'order_payment', $1, 'payment.refund_requested', $2::jsonb, $3)`;
  await client.query(insert, [
    ORPHAN_PAYMENT,
    refundRequest(ORPHAN_PAYMENT, "unknown_order", REQUESTED_AT),
    "2027-03-01T12:04:00.000Z",
  ]);
  await client.query(insert, [
    ORPHAN_PAYMENT,
    refundRequest(ORPHAN_PAYMENT, "unknown_order", "2027-03-01T12:30:00.000Z"),
    "2027-03-01T12:30:00.000Z",
  ]);
  await client.query(insert, [
    LEDGER_PAYMENT,
    refundRequest(LEDGER_PAYMENT, "order_expired", REQUESTED_AT),
    "2027-03-01T12:04:00.000Z",
  ]);
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  const all = migrations();
  const cut = all.indexOf(LAST_BEFORE_ORPHAN_OBLIGATIONS) + 1;
  expect(cut).toBeGreaterThan(0);
  await apply(all.slice(0, cut));
  await seedRefundRequests();
  await apply(all.slice(cut));
});

afterAll(async () => {
  await client.end();
});

describe("the orphan refund obligation migration on a database with unknown_order requests", () => {
  it("turns each unknown_order request into one open obligation, from its earliest request", async () => {
    const { rows } = await client.query(
      `SELECT "paymentId", "orderId", amount, currency, "capturedAt", status, "refundRequestedAt"
       FROM orphan_refund_obligations`,
    );

    expect(rows).toEqual([
      {
        paymentId: ORPHAN_PAYMENT,
        orderId: ORPHAN_ORDER,
        amount: 4200,
        currency: "EUR",
        capturedAt: new Date(REQUESTED_AT),
        status: "REFUND_REQUESTED",
        refundRequestedAt: new Date(REQUESTED_AT),
      },
    ]);
  });

  it("keeps one obligation per paymentId", async () => {
    await expect(
      client.query(
        `INSERT INTO orphan_refund_obligations
           ("paymentId", "orderId", amount, currency, "capturedAt", status, "refundRequestedAt")
         VALUES ($1, $2, 1, 'EUR', now(), 'REFUND_REQUESTED', now())`,
        [ORPHAN_PAYMENT, ORPHAN_ORDER],
      ),
    ).rejects.toThrow(/orphan_refund_obligations_pkey/);
  });
});
