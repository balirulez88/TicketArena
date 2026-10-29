import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function client(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("createPrismaClient", () => {
  it("rejects an empty connection string with a message naming the parameter", () => {
    expect(() => createPrismaClient({ connectionString: " ", driver: "pg" })).toThrow(
      /connectionString/,
    );
  });

  it("round-trips an outbox event through the pg adapter on the migrated schema", async () => {
    const created = await client().outboxEvent.create({
      data: {
        aggregateType: "order",
        aggregateId: "order-1",
        eventType: "order.placed",
        payload: { orderId: "order-1" },
      },
    });

    const found = await client().outboxEvent.findUniqueOrThrow({ where: { id: created.id } });

    expect(found.status).toBe("PENDING");
    expect(found.payload).toEqual({ orderId: "order-1" });
  });
});
