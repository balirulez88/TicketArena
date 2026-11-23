import { randomUUID } from "node:crypto";
import type { Logger } from "@ticketarena/contracts";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { bookingTestBed, freshBuyer } from "./testing";

const database = setupTestDatabase();
const { freeSeats, service } = bookingTestBed(database);

type Bindings = Record<string, unknown>;

/** Records the bindings every line is written with, whichever child wrote it. */
function recordingLogger() {
  const lines: Bindings[] = [];
  const make = (bound: Bindings): Logger => {
    const write = (fields: object, message?: string) => {
      lines.push({ ...bound, ...fields, ...(message === undefined ? {} : { msg: message }) });
    };
    return {
      info: write,
      warn: write,
      error: write,
      child: (bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

describe("booking logging", () => {
  test("every line about a booking carries its correlationId, holdId and, once placed, orderId", async () => {
    const { logger, lines } = recordingLogger();
    const alice = freshBuyer();
    const booking = service({ logger });
    const { eventId, seatIds } = await freeSeats(1);

    const hold = await booking.holdSeats(alice, eventId, seatIds);
    const held = lines.length;
    const order = await booking.placeOrder(
      alice,
      hold.id,
      { email: "alice@example.com" },
      randomUUID(),
    );

    expect(held).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(held);
    for (const line of lines) {
      expect(line).toMatchObject({ correlationId: hold.correlationId, holdId: hold.id });
    }
    for (const line of lines.slice(held)) {
      expect(line).toMatchObject({ orderId: order.id });
    }
  });

  test("a replayed placeOrder logs no 'order placed' line and returns the original order view", async () => {
    const { logger, lines } = recordingLogger();
    const alice = freshBuyer();
    const booking = service({ logger });
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await booking.holdSeats(alice, eventId, seatIds);
    const key = randomUUID();
    const contact = { email: "alice@example.com" };

    const [first, ...duplicates] = await Promise.all(
      Array.from({ length: 4 }, () => booking.placeOrder(alice, hold.id, contact, key)),
    );
    const replay = await booking.placeOrder(alice, hold.id, contact, key);

    for (const duplicate of [...duplicates, replay]) {
      expect(duplicate).toEqual(first);
      expect(duplicate).not.toHaveProperty("kind");
    }
    expect(lines.filter(({ msg }) => msg === "order placed")).toHaveLength(1);
  });
});
