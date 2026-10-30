import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Principal } from "../identity/identity";
import { createCaller } from "./_app";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const alice: Principal = { kind: "guest", sessionId: "a".repeat(32) };
const bob: Principal = { kind: "guest", sessionId: "b".repeat(32) };

function caller(principal: Principal) {
  return createCaller({ now: () => NOW, principal, db: db() });
}

async function availableSeat() {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seat = await db().seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
  });
  return { eventId: event.id, seatId: seat.id };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("booking.holdSeats", () => {
  test("holds a seat and returns the hold with its expiry", async () => {
    const { eventId, seatId } = await availableSeat();

    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    expect(hold).toMatchObject({
      eventId,
      seatIds: [seatId],
      status: "HELD",
      holdExpiresAt: new Date("2027-03-01T12:10:00.000Z"),
    });
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).claimBuyerKey).toBe(
      alice.sessionId,
    );
  });

  test("a seat that is already held is CONFLICT naming SEAT_UNAVAILABLE and the seat id", async () => {
    const { eventId, seatId } = await availableSeat();
    await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    await expect(
      caller(bob).booking.holdSeats({ eventId, seatIds: [seatId] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(`SEAT_UNAVAILABLE: ${seatId}`),
    });
  });

  test("rejects a malformed seat id naming the field", async () => {
    const { eventId } = await availableSeat();

    await expect(
      caller(alice).booking.holdSeats({ eventId, seatIds: ["nope"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("seatIds") });
  });
});

describe("booking.getHold", () => {
  test("returns the hold to its owner", async () => {
    const { eventId, seatId } = await availableSeat();
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    expect(await caller(alice).booking.getHold({ holdId: hold.id })).toEqual(hold);
  });

  test("is NOT_FOUND for anyone but the owner", async () => {
    const { eventId, seatId } = await availableSeat();
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    await expect(caller(bob).booking.getHold({ holdId: hold.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("booking.placeOrder / getOrder", () => {
  const contact = { email: "alice@example.com" };

  async function heldHold() {
    const { eventId, seatId } = await availableSeat();
    return caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });
  }

  test("places an order without admission and is idempotent per key", async () => {
    const hold = await heldHold();
    const idempotencyKey = randomUUID();

    const order = await caller(alice).booking.placeOrder({
      holdId: hold.id,
      contact,
      idempotencyKey,
    });
    const replay = await caller(alice).booking.placeOrder({
      holdId: hold.id,
      contact,
      idempotencyKey,
    });

    expect(order).toMatchObject({ holdId: hold.id, status: "PENDING_PAYMENT", contact });
    expect(replay).toEqual(order);
    expect(await caller(alice).booking.getOrder({ orderId: order.id })).toEqual(order);
  });

  test("getOrder is NOT_FOUND for anyone but the owner", async () => {
    const hold = await heldHold();
    const order = await caller(alice).booking.placeOrder({
      holdId: hold.id,
      contact,
      idempotencyKey: randomUUID(),
    });

    await expect(caller(bob).booking.getOrder({ orderId: order.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("maps domain refusals to tRPC codes", async () => {
    const hold = await heldHold();
    const idempotencyKey = randomUUID();
    await caller(alice).booking.placeOrder({ holdId: hold.id, contact, idempotencyKey });

    await expect(
      caller(bob).booking.placeOrder({ holdId: hold.id, contact, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(alice).booking.placeOrder({
        holdId: hold.id,
        contact: { email: "x@example.com" },
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("IDEMPOTENCY_KEY_REUSED"),
    });
    await expect(
      caller(alice).booking.placeOrder({ holdId: hold.id, contact, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("HOLD_NOT_ACTIVE"),
    });
  });

  test("HOLD_EXPIRED is a PRECONDITION_FAILED", async () => {
    const hold = await heldHold();
    const late = createCaller({
      now: () => new Date("2027-03-01T12:10:00.000Z"),
      principal: alice,
      db: db(),
    });

    await expect(
      late.booking.placeOrder({ holdId: hold.id, contact, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("HOLD_EXPIRED"),
    });
  });

  test("rejects a malformed email naming the field", async () => {
    const hold = await heldHold();

    await expect(
      caller(alice).booking.placeOrder({
        holdId: hold.id,
        contact: { email: "nope" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("email") });
  });
});
