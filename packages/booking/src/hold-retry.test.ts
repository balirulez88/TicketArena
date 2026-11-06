import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type BookingMetric, type Buyer, createBookingService } from "./index";
import { backendPid, latch, waitUntilBlockedBy } from "./pg-blocking";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");
let seedClient: PrismaClient | undefined;

function seeder(): PrismaClient {
  seedClient ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return seedClient;
}

function buyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(seeder(), NOW);
});

afterAll(async () => {
  await seedClient?.$disconnect();
});

async function twoSeats() {
  const event = await seeder().event.findFirstOrThrow({ where: { demo: true } });
  // Lowest ids first: the service locks in id order, so [first, second] is its lock order.
  const seats = await seeder().seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "desc" },
    take: 2,
  });
  const [second, first] = seats.map((seat) => seat.id);
  return { eventId: event.id, first: first ?? "", second: second ?? "" };
}

function recording(newId: () => string = randomUUID) {
  const counted: BookingMetric[] = [];
  const service = createBookingService({
    db: seeder(),
    clock: { now: () => NOW },
    newId,
    metrics: {
      increment: (metric) => {
        counted.push(metric);
        return Promise.resolve();
      },
    },
  });
  return { service, counted };
}

class Rollback extends Error {}

/**
 * Makes the service the deadlock victim: an outside transaction locks the service's second seat,
 * waits until the service is blocked on it holding the first, then asks for the first. The
 * service started waiting earlier, so its deadlock check fires first and Postgres aborts it
 * (40P01). The outside transaction then rolls back, leaving both seats free for the retry.
 */
async function deadlockWith<T>(first: string, second: string, whileDeadlocked: () => Promise<T>) {
  const locked = latch();
  const pid = latch();
  let outsidePid = 0;
  const outside = seeder()
    .$transaction(async (tx) => {
      outsidePid = await backendPid(tx);
      await tx.$queryRaw`SELECT id FROM seats WHERE id = ${second}::uuid FOR UPDATE`;
      locked.open();
      await pid.promise;
      await tx.$queryRaw`SELECT id FROM seats WHERE id = ${first}::uuid FOR UPDATE`;
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) {
        throw error;
      }
    });
  await locked.promise;
  const attempt = whileDeadlocked();
  await waitUntilBlockedBy(seeder(), outsidePid);
  pid.open();
  await outside;
  return attempt;
}

describe("deadlock retry", () => {
  test("a hold aborted by a deadlock is retried and succeeds, counting deadlock_retry", async () => {
    const { eventId, first, second } = await twoSeats();
    const { service, counted } = recording();

    const hold = await deadlockWith(first, second, () =>
      service.holdSeats(buyer(), eventId, [first, second]),
    );

    expect(hold.status).toBe("HELD");
    expect(hold.seatIds.sort()).toEqual([first, second].sort());
    expect(counted).toContain("deadlock_retry");
    expect(counted).toContain("hold_ok");
    expect(counted).not.toContain("booking_busy");
  }, 30_000);
});

describe("atomicity (TD-018)", () => {
  async function untouched(seatIds: string[], holdIds: string[]) {
    const seats = await seeder().seat.findMany({ where: { id: { in: seatIds } } });
    expect(seats.map((seat) => [seat.status, seat.holdId, seat.claimBuyerKey])).toEqual(
      seats.map(() => ["AVAILABLE", null, null]),
    );
    expect(await seeder().hold.count({ where: { id: { in: holdIds } } })).toBe(0);
  }

  /** An envelope id already in the outbox, made by a real hold, for a later insert to collide with. */
  async function takenEnvelopeId(): Promise<string> {
    const { eventId, second } = await twoSeats();
    const { service } = recording();
    const hold = await service.holdSeats(buyer(), eventId, [second]);
    const row = await seeder().outboxEvent.findFirstOrThrow({
      where: { aggregateId: hold.id },
      select: { id: true },
    });
    return row.id;
  }

  /** newId feeds: holdId, correlationId, then the outbox envelope id that collides. */
  function failingOutbox(duplicate: string, holdId: string) {
    const ids = [holdId, randomUUID(), duplicate];
    return () => ids.shift() ?? randomUUID();
  }

  test("a failing outbox insert leaves no hold, no claim and the seat AVAILABLE", async () => {
    const duplicate = await takenEnvelopeId();
    const { eventId, first } = await twoSeats();
    const holdId = randomUUID();
    const { service } = recording(failingOutbox(duplicate, holdId));

    await expect(service.holdSeats(buyer(), eventId, [first])).rejects.toMatchObject({
      code: "P2002",
    });

    await untouched([first], [holdId]);
  });

  test("the same failure after a deadlock retry also leaves nothing behind", async () => {
    const duplicate = await takenEnvelopeId();
    const { eventId, first, second } = await twoSeats();
    const holdId = randomUUID();
    const { service, counted } = recording(failingOutbox(duplicate, holdId));

    await expect(
      deadlockWith(first, second, () => service.holdSeats(buyer(), eventId, [first, second])),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(counted).toContain("deadlock_retry");
    await untouched([first, second], [holdId]);
  }, 30_000);
});
