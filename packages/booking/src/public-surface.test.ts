import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import * as entry from "./index";

// What code outside the package uses, plus the transaction settings the app composes with.
// Anything only tests need is imported by them from its own module.
const PERMITTED_VALUES = [
  "BOOKING_ACQUIRE_TIMEOUT_MS",
  "BookingBusyError",
  "DEFAULT_BOOKING_TIMEOUTS",
  "HoldExpiredError",
  "HoldNotActiveError",
  "HoldNotFoundError",
  "HoldSeatSetMissingError",
  "IdempotencyKeyReusedError",
  "InvalidSeatSelectionError",
  "LimitExceededError",
  "MAX_SEATS_PER_BUYER",
  "MixedCurrencyError",
  "NotDemoEventError",
  "NotOnSaleError",
  "ResetBlockedError",
  "SeatUnavailableError",
  "bookingTransactionOptions",
  "createBookingService",
  "createPaymentSagaHandler",
  "createRedisBookingMetrics",
  "createRedisBookingMetricsReader",
  "createRedisBookingMetricsReset",
  "worstCaseBookingBusyMs",
];

const PERMITTED_TYPES = [
  "BookingMetricCounts",
  "BookingMetrics",
  "BookingMetricsReader",
  "BookingMetricsReset",
  "BookingService",
  "BookingTimeouts",
  "Buyer",
  "HoldView",
  "RedisMetricsClient",
  "RedisMetricsDeleteClient",
  "RedisMetricsReadClient",
  "SagaMetrics",
  "SweepResult",
];

function difference(actual: readonly string[], permitted: readonly string[]) {
  return {
    unexpected: actual.filter((name) => !permitted.includes(name)),
    missing: permitted.filter((name) => !actual.includes(name)),
  };
}

describe("the package's main entry", () => {
  test("exports at runtime exactly the permitted names", () => {
    expect(difference(Object.keys(entry).sort(), PERMITTED_VALUES)).toEqual({
      unexpected: [],
      missing: [],
    });
  });

  test("exports exactly the permitted types", () => {
    // Types vanish at runtime, so they are read from the source: every `type X` in an export list.
    const source = readFileSync(resolve(__dirname, "index.ts"), "utf8");
    const exportLists = [...source.matchAll(/export\s*(type\s*)?\{([^}]*)\}/g)];
    const types = exportLists.flatMap(([, wholeListIsType, names = ""]) =>
      names
        .split(",")
        .map((name) => name.trim())
        .filter((name) => wholeListIsType !== undefined || name.startsWith("type "))
        .map((name) => name.replace(/^type\s+/, "")),
    );
    const otherExports = [...source.matchAll(/^export\s+(?!\{|type\s*\{)(.*)$/gm)].map(
      ([line]) => line,
    );

    expect(difference(types.sort(), PERMITTED_TYPES)).toEqual({ unexpected: [], missing: [] });
    // Only re-export lists: a declaration or `export *` here would bypass the lists above.
    expect(otherExports).toEqual([]);
  });
});
