import { describe, expect, test } from "vitest";
import {
  BOOKING_ACQUIRE_TIMEOUT_MS,
  type BookingTimeouts,
  bookingTransactionOptions,
  DEFAULT_BOOKING_TIMEOUTS,
  LOCK_WAITS_ON_LONGEST_PATH,
  RETRY_JITTER_MAX_MS,
  TRANSACTION_MARGIN_MS,
  worstCaseBookingBusyMs,
} from "./booking-transaction";

describe("booking transaction settings", () => {
  test("production runs lock_timeout 3s, statement_timeout 5s and 3 retries (ADR 0005)", () => {
    expect(DEFAULT_BOOKING_TIMEOUTS).toEqual({
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 5_000,
      retries: 3,
    });
  });

  test("the Prisma timeout covers every lock wait of placeOrder, one statement and the margin", () => {
    const { lockTimeoutMs, statementTimeoutMs } = DEFAULT_BOOKING_TIMEOUTS;
    const { timeoutMs } = bookingTransactionOptions(DEFAULT_BOOKING_TIMEOUTS);

    // placeOrder waits on the buyer advisory lock, the hold row and the seat rows.
    expect(LOCK_WAITS_ON_LONGEST_PATH).toBe(3);
    expect(TRANSACTION_MARGIN_MS).toBeGreaterThan(0);
    expect(timeoutMs).toBeGreaterThanOrEqual(
      LOCK_WAITS_ON_LONGEST_PATH * lockTimeoutMs + statementTimeoutMs + TRANSACTION_MARGIN_MS,
    );
    expect(timeoutMs).toBe(15_000);
  });

  test("maxWait is the pool acquire timeout, so a transaction waits for a connection no longer than a read", () => {
    expect(bookingTransactionOptions(DEFAULT_BOOKING_TIMEOUTS).maxWaitMs).toBe(
      BOOKING_ACQUIRE_TIMEOUT_MS,
    );
    expect(BOOKING_ACQUIRE_TIMEOUT_MS).toBe(3_000);
  });

  test("the budget follows injected timeouts", () => {
    expect(
      bookingTransactionOptions({ lockTimeoutMs: 1_000, statementTimeoutMs: 2_000, retries: 0 }),
    ).toEqual({ maxWaitMs: BOOKING_ACQUIRE_TIMEOUT_MS, timeoutMs: 6_000 });
  });
});

describe("worst case to BOOKING_BUSY", () => {
  const base = { maxWaitMs: 3_000, maxJitterMs: 200 };

  test("for the production defaults it is 72.6 s", () => {
    // 4 attempts × (3 s maxWait + 15 s transaction) + 3 retries × 200 ms jitter.
    expect(worstCaseBookingBusyMs()).toBe(72_600);
    expect(worstCaseBookingBusyMs(DEFAULT_BOOKING_TIMEOUTS, base)).toBe(72_600);
  });

  function delta(change: Partial<BookingTimeouts>, options = base): number {
    return (
      worstCaseBookingBusyMs({ ...DEFAULT_BOOKING_TIMEOUTS, ...change }, options) -
      worstCaseBookingBusyMs(DEFAULT_BOOKING_TIMEOUTS, base)
    );
  }

  test("each attempt may wait lock_timeout on each of placeOrder's three locks", () => {
    expect(delta({ lockTimeoutMs: DEFAULT_BOOKING_TIMEOUTS.lockTimeoutMs + 1 })).toBe(4 * 3);
  });

  test("each attempt may spend one statement_timeout", () => {
    expect(delta({ statementTimeoutMs: DEFAULT_BOOKING_TIMEOUTS.statementTimeoutMs + 1 })).toBe(4);
  });

  test("one more retry adds a whole attempt and one jitter", () => {
    expect(delta({ retries: DEFAULT_BOOKING_TIMEOUTS.retries + 1 })).toBe(
      3_000 + 15_000 + RETRY_JITTER_MAX_MS,
    );
  });

  test("every attempt may wait maxWait to start its transaction", () => {
    expect(delta({}, { ...base, maxWaitMs: base.maxWaitMs + 1 })).toBe(4);
  });

  test("every retry may wait the maximum jitter first", () => {
    expect(delta({}, { ...base, maxJitterMs: base.maxJitterMs + 1 })).toBe(3);
  });
});
