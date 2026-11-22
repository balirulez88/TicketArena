import { describe, expect, test } from "vitest";
import {
  decide,
  type LedgerEntry,
  type SagaEvent,
  type SagaOrderState,
  type SagaOrderStatus,
} from "./saga-decision";

// AT-25: one test per cell of the spec's decision matrix (spec: Payment saga, booking side).
// The sweeper column is not an event and is not decided here.

const T = new Date("2027-03-01T12:04:30.000Z");
const DEADLINE = new Date("2027-03-01T12:05:00.000Z");
const PAYMENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PAYMENT = "22222222-2222-4222-8222-222222222222";

function order(status: SagaOrderStatus): SagaOrderState {
  return { status, totalMinor: 5_000, currency: "EUR", paymentDeadline: DEADLINE };
}

function succeeded(overrides: Partial<Extract<SagaEvent, { type: "payment.succeeded" }>> = {}) {
  return {
    type: "payment.succeeded",
    paymentId: PAYMENT,
    amount: 5_000,
    currency: "EUR",
    capturedAt: DEADLINE,
    ...overrides,
  } satisfies SagaEvent;
}

const onTime = succeeded();
const late = succeeded({ capturedAt: new Date(DEADLINE.getTime() + 1) });
const failedNotFinal: SagaEvent = { type: "payment.failed", paymentId: PAYMENT, final: false };
const failedFinal: SagaEvent = { type: "payment.failed", paymentId: PAYMENT, final: true };
const refunded: SagaEvent = { type: "payment.refunded", paymentId: PAYMENT };
const noLedger: LedgerEntry[] = [];
const known: LedgerEntry[] = [{ paymentId: PAYMENT, disposition: "APPLIED" }];

describe("decide: PENDING_PAYMENT", () => {
  const pending = order("PENDING_PAYMENT");

  test("succeeded, new payment, on time → CONFIRMED with an APPLIED ledger row", () => {
    expect(decide(pending, noLedger, onTime, T)).toEqual({
      kind: "transition",
      reason: "payment_on_time",
      order: "CONFIRMED",
      ledger: { paymentId: PAYMENT, disposition: "APPLIED" },
      at: T,
    });
  });

  test("succeeded, captured exactly at the deadline counts as on time", () => {
    expect(decide(pending, noLedger, succeeded({ capturedAt: DEADLINE }), T)).toMatchObject({
      kind: "transition",
      order: "CONFIRMED",
    });
  });

  // On time is `capturedAt <= paymentDeadline`; when the event is delivered (T) never matters.
  test.each([
    ["before the deadline", -60_000],
    ["within the settlement grace", 59_000],
    ["after the settlement grace", 3_600_000],
  ])(
    "succeeded, delivered %s → on time or late by capturedAt alone",
    (_when, deliveredAfterDeadlineMs) => {
      const delivered = new Date(DEADLINE.getTime() + deliveredAfterDeadlineMs);
      expect(decide(pending, noLedger, onTime, delivered)).toMatchObject({
        kind: "transition",
        reason: "payment_on_time",
        order: "CONFIRMED",
      });
      expect(decide(pending, noLedger, late, delivered)).toMatchObject({
        kind: "transition",
        reason: "late_capture",
        order: "EXPIRED",
      });
    },
  );

  test("succeeded, new payment, late → EXPIRED with a REFUND_REQUESTED ledger row", () => {
    expect(decide(pending, noLedger, late, T)).toEqual({
      kind: "transition",
      reason: "late_capture",
      order: "EXPIRED",
      ledger: { paymentId: PAYMENT, disposition: "REFUND_REQUESTED" },
      at: T,
    });
  });

  test("succeeded, amount differs from the order total → refund, never confirmation", () => {
    expect(decide(pending, noLedger, succeeded({ amount: 4_999 }), T)).toEqual({
      kind: "refund",
      reason: "amount_mismatch",
      paymentId: PAYMENT,
      at: T,
    });
  });

  test("succeeded, currency differs from the order's → refund, never confirmation", () => {
    expect(decide(pending, noLedger, succeeded({ currency: "HUF" }), T)).toEqual({
      kind: "refund",
      reason: "amount_mismatch",
      paymentId: PAYMENT,
      at: T,
    });
  });

  test("succeeded, known payment → noop (duplicate_payment)", () => {
    expect(decide(pending, known, onTime, T)).toEqual({
      kind: "noop",
      reason: "duplicate_payment",
    });
  });

  test("failed, not final → noop (attempt_failed)", () => {
    expect(decide(pending, noLedger, failedNotFinal, T)).toEqual({
      kind: "noop",
      reason: "attempt_failed",
    });
  });

  test("failed, final, no APPLIED row → CANCELLED", () => {
    expect(decide(pending, noLedger, failedFinal, T)).toEqual({
      kind: "transition",
      reason: "final_failure",
      order: "CANCELLED",
      ledger: null,
      at: T,
    });
  });

  test("failed, final, with an APPLIED row → noop (payment_applied)", () => {
    const applied: LedgerEntry[] = [{ paymentId: OTHER_PAYMENT, disposition: "APPLIED" }];
    expect(decide(pending, applied, failedFinal, T)).toEqual({
      kind: "noop",
      reason: "payment_applied",
    });
  });

  test("refunded, payment not in the ledger → poison (refund_for_pending_order)", () => {
    expect(decide(pending, noLedger, refunded, T)).toEqual({
      kind: "poison",
      reason: "refund_for_pending_order",
    });
  });

  // Matrix gap: an amount-mismatch refund leaves the order PENDING_PAYMENT with a
  // REFUND_REQUESTED row. The money is back, so the ledger records it rather than poisoning.
  test("refunded, ledger REFUND_REQUESTED (amount mismatch) → ledger REFUNDED", () => {
    const requested: LedgerEntry[] = [{ paymentId: PAYMENT, disposition: "REFUND_REQUESTED" }];
    expect(decide(pending, requested, refunded, T)).toEqual({
      kind: "transition",
      reason: "refund_completed",
      order: null,
      ledger: { paymentId: PAYMENT, disposition: "REFUNDED" },
      at: T,
    });
  });
});

const settledRefundReasons = {
  CONFIRMED: { onTime: "order_confirmed", late: "order_confirmed" },
  CANCELLED: { onTime: "order_cancelled", late: "order_cancelled" },
  EXPIRED: { onTime: "late_delivery", late: "order_expired" },
} as const;

describe.each(["CONFIRMED", "CANCELLED", "EXPIRED"] as const)("decide: %s", (status) => {
  const settled = order(status);

  test("succeeded, new payment, on time → refund", () => {
    expect(decide(settled, noLedger, onTime, T)).toEqual({
      kind: "refund",
      reason: settledRefundReasons[status].onTime,
      paymentId: PAYMENT,
      at: T,
    });
  });

  test("succeeded, new payment, late → refund", () => {
    expect(decide(settled, noLedger, late, T)).toEqual({
      kind: "refund",
      reason: settledRefundReasons[status].late,
      paymentId: PAYMENT,
      at: T,
    });
  });

  test("succeeded, known payment → noop (duplicate_payment)", () => {
    expect(decide(settled, known, onTime, T)).toEqual({
      kind: "noop",
      reason: "duplicate_payment",
    });
  });

  test("failed, not final → noop (order_not_pending)", () => {
    expect(decide(settled, noLedger, failedNotFinal, T)).toEqual({
      kind: "noop",
      reason: "order_not_pending",
    });
  });

  test("failed, final → noop (order_not_pending)", () => {
    expect(decide(settled, noLedger, failedFinal, T)).toEqual({
      kind: "noop",
      reason: "order_not_pending",
    });
  });

  test.each(["REFUND_REQUESTED", "MANUAL_REVIEW"] as const)(
    "refunded, ledger %s → ledger REFUNDED",
    (disposition) => {
      expect(decide(settled, [{ paymentId: PAYMENT, disposition }], refunded, T)).toEqual({
        kind: "transition",
        reason: "refund_completed",
        order: null,
        ledger: { paymentId: PAYMENT, disposition: "REFUNDED" },
        at: T,
      });
    },
  );

  test("refunded, ledger already REFUNDED → noop (already_refunded)", () => {
    const done: LedgerEntry[] = [{ paymentId: PAYMENT, disposition: "REFUNDED" }];
    expect(decide(settled, done, refunded, T)).toEqual({
      kind: "noop",
      reason: "already_refunded",
    });
  });

  test("refunded, ledger APPLIED → noop (refund_not_requested)", () => {
    expect(decide(settled, known, refunded, T)).toEqual({
      kind: "noop",
      reason: "refund_not_requested",
    });
  });
});

describe("decide: unknown orderId", () => {
  test.each([
    ["on time", onTime],
    ["late", late],
  ] as const)("succeeded (%s) for an unknown orderId → refund (unknown_order)", (_when, event) => {
    expect(decide(null, noLedger, event, T)).toEqual({
      kind: "refund",
      reason: "unknown_order",
      paymentId: PAYMENT,
      at: T,
    });
  });
});

describe("decide: unknown orderId, refunded", () => {
  test("refunded for an unknown orderId whose refund booking requested → noop (unknown_order_refunded)", () => {
    expect(decide(null, noLedger, refunded, T, { refundRequested: true })).toEqual({
      kind: "noop",
      reason: "unknown_order_refunded",
    });
  });
});

describe("decide: poison", () => {
  test.each([
    ["payment.failed", failedFinal],
    ["payment.refunded", refunded],
  ] as const)("%s for an unknown orderId → poison (unknown_order)", (_type, event) => {
    expect(decide(null, noLedger, event, T)).toEqual({ kind: "poison", reason: "unknown_order" });
  });

  test.each(["CONFIRMED", "CANCELLED", "EXPIRED"] as const)(
    "refunded for an unknown paymentId on a %s order → poison (unknown_payment)",
    (status) => {
      const other: LedgerEntry[] = [{ paymentId: OTHER_PAYMENT, disposition: "REFUND_REQUESTED" }];
      expect(decide(order(status), other, refunded, T)).toEqual({
        kind: "poison",
        reason: "unknown_payment",
      });
    },
  );
});
