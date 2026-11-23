import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PoolCounters, type PrismaClient } from "./index";

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

  it("observePool sees a caller queued for a full pool, and the queue empties once it is served", async () => {
    let counters: PoolCounters | undefined;
    const tight = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      poolMax: 1,
      observePool: (pool) => {
        counters = pool;
      },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      let holding: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const occupier = tight.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        holding();
        await gate;
      });
      await held;

      // A Prisma promise runs only once something awaits it.
      const queued = tight.$queryRaw`SELECT 1`.then(() => undefined);
      await expect.poll(() => counters?.waitingCount).toBe(1);
      release();
      await Promise.all([occupier, queued]);

      expect(counters?.waitingCount).toBe(0);
    } finally {
      release();
      await tight.$disconnect();
    }
  });
});
