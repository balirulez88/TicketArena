import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient, seedCatalog } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function client(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("payment schema", () => {
  it("owns its own outbox, processed_messages and payment_attempts tables", async () => {
    const rows = await client().$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'payment' ORDER BY table_name`;

    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(["outbox_events", "payment_attempts", "processed_messages"]),
    );
  });

  it("makes (orderId, attemptNo) unique on payment_attempts", async () => {
    const rows = await client().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'payment' AND tablename = 'payment_attempts'`;

    const unique = rows.filter((row) => /UNIQUE/i.test(row.indexdef));
    expect(unique.some((row) => /\("orderId", "attemptNo"\)/.test(row.indexdef))).toBe(true);
  });

  it("checks CAPTURED if and only if capturedAt is set on payment_attempts", async () => {
    const rows = await client().$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'payment' AND t.relname = 'payment_attempts' AND c.contype = 'c'`;

    expect(
      rows.some((row) => /CAPTURED/.test(row.definition) && /"capturedAt"/.test(row.definition)),
    ).toBe(true);
  });

  describe("order_payments", () => {
    const at = new Date("2027-03-01T12:00:00.000Z");
    const buyer = "s".repeat(32);

    async function orderWithNoPayments(): Promise<string> {
      const event = await client().event.findFirstOrThrow({ where: { demo: true } });
      const hold = await client().hold.create({
        data: {
          eventId: event.id,
          sessionId: buyer,
          buyerKey: buyer,
          holdExpiresAt: at,
          correlationId: randomUUID(),
        },
      });
      const order = await client().order.create({
        data: {
          holdId: hold.id,
          sessionId: buyer,
          buyerKey: buyer,
          contactEmail: "a@example.com",
          totalMinor: 1000,
          currency: "EUR",
          paymentDeadline: at,
          idempotencyKey: randomUUID(),
          requestHash: "h",
          correlationId: randomUUID(),
          createdAt: at,
        },
      });
      return order.id;
    }

    function payment(orderId: string, disposition: "APPLIED" | "REFUND_REQUESTED") {
      return client().orderPayment.create({
        data: {
          paymentId: randomUUID(),
          orderId,
          amount: 1000,
          currency: "EUR",
          capturedAt: at,
          disposition,
        },
      });
    }

    it("rejects a second APPLIED row for one order but allows other dispositions", async () => {
      await seedCatalog(client(), at);
      const orderId = await orderWithNoPayments();

      await payment(orderId, "APPLIED");

      await expect(payment(orderId, "APPLIED")).rejects.toThrow();
      await expect(payment(orderId, "REFUND_REQUESTED")).resolves.toBeDefined();
      expect(await client().orderPayment.count({ where: { orderId } })).toBe(2);
    });
  });
});
