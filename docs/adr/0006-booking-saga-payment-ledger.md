# 0006: Booking saga with a captured-payment ledger and refund obligations

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

Payment runs asynchronously after the booking is secured. Payments can fail, arrive late, arrive
twice, or arrive after the order has expired and its seats were resold. One order can see several
payment attempts. Money and tickets must never drift apart permanently.

## Decision

A choreographed **saga** over outbox events:
hold → `placeOrder` (order `PENDING_PAYMENT`, `order.placed`) → Payment → `payment.*` → booking saga
→ `order.confirmed | order.cancelled | order.expired`.

- **Order states describe fulfilment only:** `PENDING_PAYMENT` → `CONFIRMED | CANCELLED | EXPIRED`.
- **Money is tracked per payment**, in the booking-owned ledger `order_payments`, which holds
  **only captured payments** (`capturedAt`, `amount`, `currency` NOT NULL). Disposition:
  `APPLIED | REFUND_REQUESTED | MANUAL_REVIEW | REFUNDED`.
- At most one `APPLIED` payment per order (partial unique index), and `APPLIED` ⇔ order `CONFIRMED`,
  set in the same transaction.
- **On-time is judged by capture time**: `capturedAt <= paymentDeadline`. Late _delivery_ of an
  on-time payment still confirms, if it arrives before the sweeper expires the order at
  `paymentDeadline + 60s` settlement grace. The grace is **best-effort**, not a guarantee.
- **Always refund, never reclaim:** any captured payment that cannot be applied (late, order
  `CANCELLED`/`EXPIRED`, a second payment, amount or currency mismatch) becomes a
  `REFUND_REQUESTED` ledger row plus a `payment.refund_requested` outbox event in the same
  transaction. Seats are never reclaimed for a late payment.
- **A failed attempt is not a failed checkout:** `payment.failed` carries `final`. Only
  `final: true` on a `PENDING_PAYMENT` order with no `APPLIED` payment cancels it.
- Every (order state, event) pair is decided by a pure `decide()` function; zero-row conditional
  updates are never interpreted as success.

## Guarantee

**Eventual financial consistency:** every capture on an order we cannot fulfil gets a durable
refund obligation in the same transaction that decides it. A reconciler retries it until it is
`REFUNDED` or a human resolves `MANUAL_REVIEW`. Money is never kept silently; the refund can lag.

## Alternatives considered

- **Mark seats sold, pay later, refund on failure:** seats sit sold with no money behind them.
- **Synchronous payment in the request:** couples checkout latency and availability to the
  payment provider; drops the async story.
- **Reclaim seats for late payments if still free:** races new holds and multiplies states for a
  rare case. Rejected in favour of one deterministic rule.
- **Refund state on the order:** cannot represent several payments on one order.

## Consequences

- Late delivery beyond the grace window refunds an on-time payment; the dashboard counts these
  (`late_delivery_refund`). A pre-expiry status query to the provider (reconciliation) is phase 2.
- Refunding a `CONFIRMED` order (customer cancellation) is phase 2; `APPLIED` is terminal in MVP.
