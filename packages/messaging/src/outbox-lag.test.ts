import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { measureOutboxLag } from "./index.js";

const database = setupTestDatabase();

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
  await prisma.paymentOutboxEvent.deleteMany();
  await prisma.notificationOutboxEvent.deleteMany();
});

const BASE = new Date("2026-11-26T12:00:00.000Z");
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs);

function row(createdAt: Date, status: "PENDING" | "PUBLISHED" = "PENDING") {
  return {
    id: crypto.randomUUID(),
    aggregateType: "order",
    aggregateId: crypto.randomUUID(),
    eventType: "order.placed",
    payload: {},
    status,
    createdAt,
  };
}

describe("outbox lag (oldest PENDING age)", () => {
  it("is the age of the oldest PENDING row at the given instant, ignoring published rows", async () => {
    await prisma.outboxEvent.createMany({
      data: [row(at(-60_000), "PUBLISHED"), row(at(2_000)), row(at(5_000))],
    });

    expect(await measureOutboxLag({ prisma, now: at(9_500) })).toBe(7_500);
  });

  it("is 0 when nothing is PENDING", async () => {
    await prisma.outboxEvent.createMany({ data: [row(at(0), "PUBLISHED")] });

    expect(await measureOutboxLag({ prisma, now: at(9_500) })).toBe(0);
  });

  it("reads only the outbox of the given service", async () => {
    await prisma.outboxEvent.createMany({ data: [row(at(0))] });
    await prisma.paymentOutboxEvent.createMany({ data: [row(at(4_000))] });
    await prisma.notificationOutboxEvent.createMany({ data: [row(at(6_000))] });

    expect(await measureOutboxLag({ prisma, service: "booking", now: at(10_000) })).toBe(10_000);
    expect(await measureOutboxLag({ prisma, service: "payment", now: at(10_000) })).toBe(6_000);
    expect(await measureOutboxLag({ prisma, service: "notification", now: at(10_000) })).toBe(
      4_000,
    );
  });
});
