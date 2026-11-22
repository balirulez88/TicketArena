/**
 * The booking saga's decision matrix (spec: Payment saga, booking side; ADR 0006) as one pure
 * function. Keeping the decision free of I/O lets every matrix cell be tested on its own and
 * makes the handler's apply step a plain interpretation of the result: duplicates (`noop`),
 * invalid messages (`poison`) and not-yet-applicable ones (`retry`) can never be confused with a
 * successful change, which a zero-row conditional update could otherwise fake.
 */

export type SagaOrderStatus = "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
export type LedgerDisposition = "APPLIED" | "REFUND_REQUESTED" | "MANUAL_REVIEW" | "REFUNDED";

/** The locked order as the decision sees it; `null` when no order has the event's `orderId`. */
export interface SagaOrderState {
  readonly status: SagaOrderStatus;
  readonly totalMinor: number;
  readonly currency: string;
  readonly paymentDeadline: Date;
}

/** One order payment of the order's ledger. */
export interface LedgerEntry {
  readonly paymentId: string;
  readonly disposition: LedgerDisposition;
}

/** A validated payment event, reduced to what the matrix depends on. */
export type SagaEvent =
  | {
      readonly type: "payment.succeeded";
      readonly paymentId: string;
      readonly amount: number;
      readonly currency: string;
      readonly capturedAt: Date;
    }
  | { readonly type: "payment.failed"; readonly paymentId: string; readonly final: boolean }
  | { readonly type: "payment.refunded"; readonly paymentId: string };

export type TransitionReason =
  | "payment_on_time"
  | "late_capture"
  | "final_failure"
  | "refund_completed";
/**
 * `late_delivery`: an on-time capture that reached an already expired order. `unknown_order`: a
 * capture for an order that no longer exists.
 */
export type RefundReason =
  | "unknown_order"
  | "amount_mismatch"
  | "order_confirmed"
  | "order_cancelled"
  | "order_expired"
  | "late_delivery";
export type NoopReason =
  | "duplicate_payment"
  | "attempt_failed"
  | "payment_applied"
  | "order_not_pending"
  | "already_refunded"
  | "refund_not_requested"
  | "unknown_order_refunded";
/** No matrix cell retries today; the outcome exists for states a message may arrive before. */
export type RetryReason = "state_not_reached";
export type PoisonReason = "unknown_order" | "unknown_payment" | "refund_for_pending_order";

export type SagaDecision =
  | {
      readonly kind: "transition";
      readonly reason: TransitionReason;
      /** The order's new status, or `null` when only the ledger row changes. */
      readonly order: "CONFIRMED" | "EXPIRED" | "CANCELLED" | null;
      /** The ledger row to insert (new payment) or move (known payment), if any. */
      readonly ledger: {
        readonly paymentId: string;
        readonly disposition: "APPLIED" | "REFUND_REQUESTED" | "REFUNDED";
      } | null;
      /** The transaction's single `T`, for every timestamp the apply step writes. */
      readonly at: Date;
    }
  | {
      /**
       * Order unchanged; a `REFUND_REQUESTED` ledger row plus `payment.refund_requested` (for
       * `unknown_order` only the event: there is no order to attach a ledger row to).
       */
      readonly kind: "refund";
      readonly reason: RefundReason;
      readonly paymentId: string;
      readonly at: Date;
    }
  | { readonly kind: "noop"; readonly reason: NoopReason }
  | { readonly kind: "retry"; readonly reason: RetryReason }
  | { readonly kind: "poison"; readonly reason: PoisonReason };

/** Facts besides the order and its ledger; read only where the matrix needs them. */
export interface DecideContext {
  /**
   * Booking's outbox holds a `payment.refund_requested` for the event's payment. Consulted only
   * for a `payment.refunded` whose order is gone: an `unknown_order` refund has no ledger row,
   * so this request is the only proof that booking asked for the money back.
   */
  readonly refundRequested?: boolean;
}

export function decide(
  order: SagaOrderState | null,
  ledger: readonly LedgerEntry[],
  event: SagaEvent,
  T: Date,
  context: DecideContext = {},
): SagaDecision {
  if (order === null && event.type === "payment.refunded" && context.refundRequested === true) {
    // The refund booking requested for a vanished order is done; there is no row to record it on.
    return { kind: "noop", reason: "unknown_order_refunded" };
  }
  if (order === null) {
    // The order always commits before `order.placed` is published, so a missing order never
    // means the message arrived early. A capture still took real money, and the order can be
    // gone for good (a demo reset deletes settled orders), so it is refunded, never kept; any
    // other event for a missing order is a bad message.
    return event.type === "payment.succeeded"
      ? { kind: "refund", reason: "unknown_order", paymentId: event.paymentId, at: T }
      : { kind: "poison", reason: "unknown_order" };
  }
  switch (event.type) {
    case "payment.succeeded":
      return decideSucceeded(order, ledger, event, T);
    case "payment.failed":
      return decideFailed(order, ledger, event, T);
    case "payment.refunded":
      return decideRefunded(order, ledger, event, T);
  }
}

function decideSucceeded(
  order: SagaOrderState,
  ledger: readonly LedgerEntry[],
  event: Extract<SagaEvent, { type: "payment.succeeded" }>,
  T: Date,
): SagaDecision {
  if (ledger.some((entry) => entry.paymentId === event.paymentId)) {
    return { kind: "noop", reason: "duplicate_payment" };
  }
  // On time is decided by the provider's capture time, never by when the event is delivered.
  const onTime = event.capturedAt.getTime() <= order.paymentDeadline.getTime();
  const refund = (reason: RefundReason): SagaDecision => ({
    kind: "refund",
    reason,
    paymentId: event.paymentId,
    at: T,
  });
  switch (order.status) {
    case "PENDING_PAYMENT":
      if (!onTime) {
        return {
          kind: "transition",
          reason: "late_capture",
          order: "EXPIRED",
          ledger: { paymentId: event.paymentId, disposition: "REFUND_REQUESTED" },
          at: T,
        };
      }
      if (event.amount !== order.totalMinor || event.currency !== order.currency) {
        return refund("amount_mismatch");
      }
      return {
        kind: "transition",
        reason: "payment_on_time",
        order: "CONFIRMED",
        ledger: { paymentId: event.paymentId, disposition: "APPLIED" },
        at: T,
      };
    case "CONFIRMED":
      return refund("order_confirmed");
    case "CANCELLED":
      return refund("order_cancelled");
    case "EXPIRED":
      return refund(onTime ? "late_delivery" : "order_expired");
  }
}

function decideFailed(
  order: SagaOrderState,
  ledger: readonly LedgerEntry[],
  event: Extract<SagaEvent, { type: "payment.failed" }>,
  T: Date,
): SagaDecision {
  if (order.status !== "PENDING_PAYMENT") {
    return { kind: "noop", reason: "order_not_pending" };
  }
  if (!event.final) {
    return { kind: "noop", reason: "attempt_failed" };
  }
  if (ledger.some((entry) => entry.disposition === "APPLIED")) {
    return { kind: "noop", reason: "payment_applied" };
  }
  return { kind: "transition", reason: "final_failure", order: "CANCELLED", ledger: null, at: T };
}

function decideRefunded(
  order: SagaOrderState,
  ledger: readonly LedgerEntry[],
  event: Extract<SagaEvent, { type: "payment.refunded" }>,
  T: Date,
): SagaDecision {
  // Booking requests a refund only by writing the payment's ledger row (an `amount_mismatch` does
  // so on a still PENDING_PAYMENT order), so a payment missing from the ledger is a bad message.
  const entry = ledger.find((candidate) => candidate.paymentId === event.paymentId);
  if (entry === undefined) {
    return order.status === "PENDING_PAYMENT"
      ? { kind: "poison", reason: "refund_for_pending_order" }
      : { kind: "poison", reason: "unknown_payment" };
  }
  switch (entry.disposition) {
    case "REFUND_REQUESTED":
    case "MANUAL_REVIEW":
      return {
        kind: "transition",
        reason: "refund_completed",
        order: null,
        ledger: { paymentId: event.paymentId, disposition: "REFUNDED" },
        at: T,
      };
    case "REFUNDED":
      return { kind: "noop", reason: "already_refunded" };
    case "APPLIED":
      return { kind: "noop", reason: "refund_not_requested" };
  }
}
