# TicketArena MVP: fair on-sale, oversell-proof booking, reliable payment saga

**Status:** ready-for-agent

[← Specs](index.md) · Decisions: [ADR 0004–0013](../adr/index.md) · Vocabulary: [glossary](../glossary.md)

## Problem Statement

When tickets for a popular event go on sale, thousands of buyers arrive within seconds for a few
hundred seats. Today's typical failure modes are what buyers and operators fear:

- The site collapses under the spike, or buyers who hammer refresh (and bots) win over buyers who
  arrived on time.
- Two buyers are told they got the same seat (an oversell), or a seat stays locked forever by
  someone who walked away.
- A buyer is charged but gets no ticket, is charged twice, or gets a confirmation email for a
  booking that never really happened.
- Operators cannot see what the system is doing during the on-sale, so they cannot tell a
  healthy rush from a failure.

## Solution

TicketArena is a ticket shop for seeded events with reserved seating:

- A **waiting room** absorbs the on-sale spike. Buyers who arrive before the on-sale get a
  random, fair position; later arrivals queue in order. Buyers are admitted to seat selection at
  a controlled rate, and the backend refuses anyone who skipped the queue.
- An admitted buyer picks up to 6 seats on a seat map and gets an exclusive **hold** for 10
  minutes. A seat can never be held or sold twice, however many buyers click at once.
- At checkout the buyer gives an email (and optionally a phone number) and has a fixed 5-minute
  **payment window**. Payment runs asynchronously; the order page shows progress until the order
  is confirmed, cancelled or expired.
- Every outcome is reliable: a confirmed order always has exactly one applied payment; any money
  taken for an order that cannot be fulfilled is refunded automatically; emails go out only for
  real outcomes.
- An **admin dashboard** shows the system live: queue, seats, orders, payments, refunds, message
  health, and a live event stream. It can run a 100-buyer race for one seat and reset the demo
  event.

## User Stories

### Browsing and waiting room

1. As a buyer, I want to see a list of upcoming events with their on-sale time, so that I know when to come back.
2. As a buyer, I want an event page with venue, date, price per section and on-sale status, so that I can decide whether to queue.
3. As a buyer, I want to join the waiting room before the on-sale, so that I do not have to race at the exact second.
4. As a buyer who arrived early, I want my position to be decided fairly at random among the early arrivals, so that refreshing or scripting gives nobody an advantage.
5. As a buyer who arrives after the on-sale, I want to be placed behind everyone already waiting, in arrival order, so that the queue is predictable.
6. As a buyer, I want refreshing the page or opening a second tab to keep my place, so that I am not punished for a flaky connection.
7. As a buyer, I want to see my position and an estimated wait, updated every few seconds, so that I know the queue is moving.
8. As a buyer, I want to be moved to seat selection automatically when admitted, so that I do not miss my turn.
9. As a buyer, I want to leave the queue explicitly, so that my place goes to someone else.
10. As a buyer arriving outside the queue window, I want to be admitted immediately, so that a quiet sale has no needless waiting.
11. As a buyer in queues for two events, I want each admission to be separate, so that one does not interfere with the other.

### Seat selection and holds

12. As an admitted buyer, I want a seat map showing available, held and sold seats by section, so that I can choose where to sit.
13. As a keyboard or screen-reader user, I want every seat to be a focusable control with a descriptive label (section, row, number, price, status), so that I can select seats without a mouse.
14. As a buyer, I want to select up to 6 seats and hold them in one action, so that my group sits together.
15. As a buyer, I want a multi-seat hold to succeed for all seats or none, so that I never end up with half a group.
16. As a buyer, I want a clear message listing which seats were just taken when my hold fails, so that I can pick others quickly.
17. As a buyer, I want a countdown showing when my hold expires, based on the server's time, so that I know how long I have.
18. As a buyer, I want to release my hold, so that I can change my mind and free the seats for others.
19. As a buyer, I want to be told the system is busy and to retry when the booking path is saturated, so that I am not shown a false "sold out".
20. As a buyer, I want to be told when I have reached the 6-ticket limit for an event (held, in checkout and bought together), so that I understand why a hold is refused.
21. As a buyer whose admission has been revoked or never existed, I want holding seats to be refused, so that the queue is fair for everyone.

### Checkout and payment

22. As a buyer with a valid hold, I want to check out with my email and optional phone number, so that I can receive my tickets.
23. As a buyer, I want checkout to work even if my 30-minute admission has expired, as long as my hold is still valid, so that I am not kicked out mid-purchase.
24. As a buyer, I want a fixed 5-minute payment window once I start checkout, so that my seats stay reserved while I pay.
25. As a buyer whose browser retried the checkout request, I want to get the same order back rather than a second order, so that I am never charged twice for one click.
26. As a buyer, I want an order status page that updates until the order is confirmed, cancelled or expired, so that I know the outcome.
27. As a buyer whose payment succeeded, I want my order confirmed and a confirmation email sent, so that I have proof of purchase.
28. As a buyer whose payment failed definitively, I want my order cancelled, my seats released and an email telling me so, so that I can try again.
29. As a buyer whose single payment attempt failed but who may still retry, I want my order to stay open until the deadline, so that one declined attempt does not cancel everything (retry UI is phase 2; the model supports it).
30. As a buyer who paid just before the deadline, I want my order confirmed even if the payment confirmation arrives a little late, so that on-time payers are honoured whenever possible.
31. As a buyer who paid after the deadline, or whose on-time payment arrived after the order already expired, I want an automatic full refund and an email explaining it, so that I never pay without getting tickets.
32. As a buyer who was charged twice for one order, I want the extra charge refunded automatically, so that I pay exactly once.
33. As a buyer whose hold expired before checkout, I want checkout refused with a clear "hold expired" message, so that I can start again.
34. As a buyer awaiting a refund, I want an email when the refund is initiated and another when it completes, so that I can track my money.

### Notifications

35. As a buyer, I want exactly one confirmation email per confirmed order in normal operation, so that my inbox is not spammed by retries.
36. As a buyer, I want notifications for cancelled orders, expired orders, refund initiated and refund completed, so that every outcome is communicated.

### Admin dashboard and demos

37. As an admin, I want to log in with an admin password, so that only operators see the dashboard.
38. As an admin, I want a live snapshot refreshed every second: seats by status, orders by status, pending payments, queue length and active shoppers, so that I see the on-sale as it happens.
39. As an admin, I want separate counters for successful holds, ordinary unavailable-seat refusals, lost races (prevented double bookings), busy refusals, deadlock retries and limit refusals, so that I can tell real contention from ordinary clicks on sold seats.
40. As an admin, I want a live event stream (seat held, order placed, payment succeeded/failed, order confirmed, refunds, expiries), groupable by correlation id, so that I can follow one booking's whole saga.
41. As an admin, I want message-health indicators (outbox lag, consumer lag, pending acks, redeliveries, DLQ size and oldest age), so that I can see delivery problems before they hurt buyers.
42. As an admin, I want to see stuck refunds (requested long ago or in manual review) with their age, and retry one with a button, so that no customer's money is forgotten.
43. As an admin, I want a counter of on-time payments that were refunded because they were delivered late, so that the grace-period trade-off is visible.
44. As an admin, I want a "run race" button that makes 100 synthetic buyers try to hold the same seat at once and shows the result (1 success, the rest refused, with timing), so that I can prove no double booking in a live demo.
45. As an admin, I want a "reset demo" button that restores the demo event, so that I can repeat the demo.
46. As an admin, I want destructive demo actions limited to the demo event and rate-limited, so that a public demo cannot damage real data or be spammed.

### Operator and developer

47. As an operator, I want failed messages retried with increasing delays and moved to a dead-letter queue after the retry budget, so that one bad message never blocks the rest and nothing is silently dropped.
48. As an operator, I want a documented, scripted procedure to recreate a consumer that never skips unprocessed messages, so that recovery is safe under pressure.
49. As an operator, I want to re-publish outbox events for a time range, so that I can recover from broker data loss.
50. As an operator, I want structured JSON logs carrying correlation and causation ids, so that I can trace one booking across web and worker.
51. As a developer, I want every critical business rule covered by integration tests on real Postgres, Redis and NATS, so that refactoring cannot silently break correctness.
52. As a developer, I want CI to run the full gate (lint, typecheck, unit and integration tests) from the very first slice, so that `main` is always green.
53. As a developer, I want load-test scripts and recorded results, so that capacity claims are evidence-based.
54. As a reviewer, I want a live deployment and docs that explain every decision, so that I can evaluate the design quickly.

## Implementation Decisions

### Modules

Deep modules with one public entry point each; nothing reaches into another module's internals.
Apps are thin composition roots.

| Module         | Responsibility                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `contracts`    | Zod schemas for the event envelope and every event payload, shared by web and worker                                         |
| `db`           | Prisma schema (multiSchema: `public`, `payment`, `notification`), migrations, client factory with injected driver adapter    |
| `booking`      | `BookingService`: holds, orders, saga decisions, sweeper and reconciler logic, booking metrics                               |
| `waiting-room` | `QueueService` with Lua scripts, `QueueStore` port and adapters, `AdmissionPolicy` port, admission tokens                    |
| `messaging`    | `MessageBus` port, JetStream adapter, topology, relay, consumer runner (retry/DLQ), recovery tooling                         |
| web app        | tRPC routers as thin adapters over services, `IdentityService`, UI, admin dashboard, session `proxy.ts`                      |
| worker app     | Modules: relay, payment (mock), notification (mock), booking saga consumer, sweeper, reconciler, admission ticker; `/health` |

Interfaces (shape level):

- `BookingService`: `holdSeats(principal, eventId, seatIds)`, `releaseHold(principal, holdId)`,
  `placeOrder(principal, holdId, contact, idempotencyKey)`, `getHold`, `getOrder`, seat-map read,
  `handlePaymentEvent(envelope)`, `sweepExpired()`, `reconcileRefunds()`, `retryRefund(paymentId)`.
- `QueueService`: `join`, `status` (position, ETA, admitted), `leave`, `heartbeat`, `admitTick`,
  `reap`, `releaseSlot`, `isAdmitted(jti)`.
- `AdmissionPolicy`: `isQueueActive(event, now)`. MVP reads the schedule.
- `IdentityService`: `resolve(cookies) → Principal`.
- `MessageBus`: `publish(subject, envelope, dedupeId)`, `subscribe(consumer, handler)`; the handler
  outcome is ack / retry(delay) / dead-letter.
- `Clock` (`now()`) and `Random` are injected everywhere; no module reads the system clock or
  `Math.random` directly, and no package reads `process.env`.

### Identity

- `Principal = { kind: "guest", sessionId } | { kind: "user", sessionId, userId }` (user in phase 2).
- `BuyerKey = userId ?? sessionId`. Limits and ownership use `BuyerKey`.
- Session cookie `ta_session`: random 128-bit id, HMAC-signed with `SESSION_SECRET`, `httpOnly`,
  `Secure`, `SameSite=Lax`, 7 days, issued in Next.js 16 `proxy.ts`. A bad signature yields a new
  session.
- Guest limits can be bypassed by clearing cookies; accepted and documented for the MVP.
- Secrets `SESSION_SECRET`, `ADMISSION_SECRET` (each at least 32 bytes) and `ADMIN_PASSWORD` are
  validated at the app boundary.

### Catalog (seeded)

- Seed script: 1–2 venues with sections, rows and seats; price per section in integer minor units,
  currency EUR; 2–3 events with `onSaleAt` and a queue window; one event flagged `demo`.
- No catalog CRUD.

### Data model (booking, `public` schema)

- **Seat** (per event): `status` `AVAILABLE | HELD | IN_CHECKOUT | SOLD`, `holdId?`, `claimBuyerKey?`.
- **Hold:** `id`, `eventId`, `sessionId`, `userId?`, `buyerKey`, `status` `HELD | ORDERED | RELEASED | EXPIRED`,
  `holdExpiresAt`, `correlationId`.
- **Order:** `id`, `holdId` (unique), `eventId`, `sessionId`, `userId?`, `buyerKey`, contact (email,
  phone?), `totalMinor`, `currency`, `status` `PENDING_PAYMENT | CONFIRMED | CANCELLED | EXPIRED`,
  `paymentDeadline`, `idempotencyKey`, `requestHash` (unique `(sessionId, idempotencyKey)`),
  `correlationId`.
- **Order line:** seat, section, price copied at `placeOrder` (never re-read later).
- **Order payment (ledger, captured money only):** `paymentId` (PK), `orderId`, `amount`,
  `currency`, `capturedAt` (all NOT NULL), `disposition` `APPLIED | REFUND_REQUESTED | MANUAL_REVIEW | REFUNDED`,
  `refundRequestedAt?`, `refundAttempts`. Partial unique index: one `APPLIED` per order.
- **Outbox** and **processed messages** per schema (see Messaging).
- All timestamps `timestamptz`, UTC.

### Data model (`payment` and `notification` schemas)

- `payment.payment_attempts`: unique `(orderId, attemptNo)`, `paymentId`, `status`
  `ATTEMPTING | CAPTURED | FAILED`, `capturedAt?`, `failureReason?`, amount, currency, contact.
  CHECK: `CAPTURED ⇔ capturedAt IS NOT NULL`; `FAILED ⇔ failureReason IS NOT NULL`.
- `payment.refunds`: unique `paymentId`.
- `notification.notifications`: `sourceEventId`, `channel` `EMAIL | SMS`, recipient, template,
  `status` `PENDING | SENT`; unique `(sourceEventId, channel)`.
- No cross-schema foreign keys or reads; services learn about each other only from events.

### Holding seats (`holdSeats`)

Requires admission (see Waiting room). 1–6 seat ids, all from one event.

1. **Snapshot fast path (no locks):** if any requested seat is visibly `SOLD`, `IN_CHECKOUT`, or
   `HELD` with an unexpired hold, return `SEAT_UNAVAILABLE` with those seat ids and count
   `seat_unavailable`. This is an optimization; the locked step alone decides success.
2. One short transaction (`lock_timeout` 3s, `statement_timeout` 5s), locks in the global order:
   1. `pg_advisory_xact_lock(hash(eventId:buyerKey))`.
   2. Seats `SELECT … WHERE id = ANY(…) ORDER BY id FOR UPDATE`.
   3. `T = clock.now()`, read **after** the locks are held.
   4. A seat is free iff `AVAILABLE`, or `HELD` and its hold has `holdExpiresAt <= T`.
      `IN_CHECKOUT` and `SOLD` are never free.
   5. Any seat not free: roll back, return `SEAT_UNAVAILABLE` (seat ids), count `race_lost` when
      the snapshot had said free.
   6. **Limit:** `usage = count of seats in this event with claimBuyerKey = buyerKey that are
      (HELD with hold not expired at T) or IN_CHECKOUT or SOLD`. If `usage + requested > 6`, roll
      back with `LIMIT_EXCEEDED`. Counting seats, not holds or orders, means a hold that becomes an
      order is never counted twice.
   7. Insert the hold (`holdExpiresAt = T + 10 min`, new `correlationId`); set seats `HELD` with
      `holdId` and `claimBuyerKey`; write outbox `seat.held`. Commit.
3. Errors `40P01`, `55P03`, `40001` retry the whole transaction up to 3 times with jitter
   (`deadlock_retry`), then return `BOOKING_BUSY` (tRPC `TOO_MANY_REQUESTS`, retryable). A pool
   acquire timeout also yields `BOOKING_BUSY`.
4. On success count `hold_ok`. Metric increments happen after commit, fire-and-forget; a Redis
   failure is logged and never fails a booking.

### Releasing a hold

Owner-only (`buyerKey` match), `HELD` status only: hold → `RELEASED`, its seats → `AVAILABLE`
(only seats whose `holdId` is this hold), outbox `hold.released`. Releasing a hold does not end
shopping: the active waiting-room slot stays until order placed, leave, or reaping.

### Placing an order (`placeOrder`)

Does **not** require admission. Authorization is ownership of a valid hold.

1. Idempotency first: if `(sessionId, idempotencyKey)` exists, return the existing order when
   `requestHash` matches, else `IDEMPOTENCY_KEY_REUSED`. A concurrent duplicate that loses the
   unique-constraint race re-reads and returns the winner's order. A replay returns the original
   order even after the hold has expired.
2. One transaction, locks in the global order: buyer advisory lock → hold `FOR UPDATE` → its seats
   `ORDER BY id FOR UPDATE`; then `T = clock.now()`.
3. Validate: hold exists; `hold.buyerKey = BuyerKey` (else `NOT_FOUND`, never leaking existence);
   hold `status = HELD`; `T < holdExpiresAt` (else `HOLD_EXPIRED`); **every seat still has
   `status = HELD` and `holdId = this hold`** (protects against clock skew between instances and
   lazy takeover); no order for this hold yet.
4. Create the order `PENDING_PAYMENT` with `paymentDeadline = T + 5 min` (fixed, never extended),
   order lines with copied prices, the hold's `correlationId`; hold → `ORDERED`; seats →
   `IN_CHECKOUT`; outbox `order.placed`. Commit.
5. After commit, release the buyer's active waiting-room slot (which revokes admission).

### Expiry: lazy plus sweeper

- **Holds:** lazy (step 2.4 of `holdSeats`) plus the sweeper. The sweeper runs every 15s:
  `FOR UPDATE SKIP LOCKED` on holds with `status = HELD AND holdExpiresAt <= T`; moves them to
  `EXPIRED`, frees seats whose `holdId` is that hold, writes `hold.expired`. Under READ COMMITTED
  the `WHERE` is re-checked after any lock wait, so a hold that `placeOrder` just converted is no
  longer matched.
- **Orders:** the sweeper expires `PENDING_PAYMENT` orders with
  `paymentDeadline + settlementGrace (60s) <= T` (`SKIP LOCKED`): order → `EXPIRED`, seats →
  `AVAILABLE`, outbox `order.expired`.
- **Invariant:** `IN_CHECKOUT` seats are freed only in the same transaction as the order
  transition that ends checkout (`CANCELLED` or `EXPIRED`). No lazy path frees them.
- Race outcomes, all serialized by the hold row lock:
  - `placeOrder` first → hold `ORDERED`; the sweeper skips or no longer matches it.
  - Sweeper first → hold `EXPIRED`; `placeOrder` returns `HOLD_EXPIRED`.
  - Sweeper not yet run → `placeOrder`'s own `T < holdExpiresAt` check rejects an expired hold.
- One `T` per transaction; the same strict rule everywhere: a hold is valid iff `T < holdExpiresAt`.

### Payment saga (booking side)

The booking saga consumer handles `payment.succeeded`, `payment.failed` and `payment.refunded`.
In one transaction: dedupe check → lock the order `FOR UPDATE` (then seats if they change) →
`T = clock.now()` → `decide(orderState, ledger, event)` → apply → insert `processed_messages` →
outbox writes → commit.

`decide` is a pure function returning `transition | noop | refund | retry | poison`. Zero-row
conditional updates are never treated as success. Unknown `orderId` or unknown `paymentId` on a
refund event is `poison` (the order always commits before `order.placed` is published, so a
missing order means a bad message). Every `noop` is logged with a reason code. `retry` (state not
yet reached) does not occur in today's flow but is supported.

"On time" means `capturedAt <= order.paymentDeadline`. "Refund" means: insert a ledger row with
`REFUND_REQUESTED` and write outbox `payment.refund_requested`, in the same transaction.
A success whose amount or currency differs from the order total is always refunded.

| Order state     | `succeeded`, new payment, on time                              | `succeeded`, new payment, late                 | `succeeded`, known payment | `failed`, not final | `failed`, final                                              | `refunded`                                                       | Sweeper (deadline + grace) |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------- | -------------------------- | ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------- |
| PENDING_PAYMENT | → CONFIRMED, ledger `APPLIED`, seats `SOLD`, `order.confirmed` | → EXPIRED, free seats, `order.expired`, refund | noop (duplicate)           | log + metric, noop  | → CANCELLED (if no `APPLIED`), free seats, `order.cancelled` | poison                                                           | → EXPIRED, free seats      |
| CONFIRMED       | refund                                                         | refund                                         | noop (duplicate)           | noop                | noop                                                         | ledger → `REFUNDED` if it was `REFUND_REQUESTED`/`MANUAL_REVIEW` | noop                       |
| CANCELLED       | refund                                                         | refund                                         | noop (duplicate)           | noop                | noop                                                         | ledger → `REFUNDED`                                              | noop                       |
| EXPIRED         | refund                                                         | refund                                         | noop (duplicate)           | noop                | noop                                                         | ledger → `REFUNDED`                                              | noop                       |

Every refund caused by an on-time payment delivered after expiry increments `late_delivery_refund`.

### Refund obligations and reconciliation

- **Guarantee: eventual financial consistency.** Every capture on an order that cannot be fulfilled
  gets a durable refund obligation in the same transaction that decides it. The system retries it
  until it is `REFUNDED` or a human resolves `MANUAL_REVIEW`. Money is never kept silently; the
  refund can lag.
- Ledger disposition transitions: `REFUND_REQUESTED → REFUNDED | MANUAL_REVIEW`;
  `MANUAL_REVIEW → REFUND_REQUESTED | REFUNDED`. `APPLIED` is terminal in the MVP.
- Execution: the Payment consumer refunds idempotently (unique `paymentId` in `payment.refunds`)
  and emits `payment.refunded`; transient failures follow the retry schedule, then the DLQ.
- Reconciler (worker, every 5 min): each `REFUND_REQUESTED` row older than 10 min gets its event
  re-emitted through the outbox and `refundAttempts` incremented. After 3 re-emits it moves to
  `MANUAL_REVIEW`. This also covers a dead-lettered or lost message.
- Escalation: the dashboard lists stuck refunds with age (`refund_pending_age_max`); "retry refund"
  moves a row from `MANUAL_REVIEW` back to `REFUND_REQUESTED` and re-emits.

### Mock Payment service

- Consumes `order.placed` and `payment.refund_requested`.
- Skips (acks, logs) an `order.placed` whose `paymentDeadline` has already passed at processing
  time; this limits side effects of large replays.
- One attempt per order in the MVP. Outcome by magic email, else random via injected `Random`
  with configurable success rate and latency:
  - `+fail@` → `payment.failed` with `final: true`
  - `+late@` → capture after the deadline (demonstrates the late-payment refund)
  - `+dup@` → publishes its result twice (demonstrates dedupe)
  - `+double@` → captures twice with two payment ids (demonstrates refund of the extra charge)
- Invariant (tested in the module): never emits `final: true` while another attempt for the order
  is in flight or captured.
- Events carry `capturedAt` (provider time), distinct from delivery time. Clock skew between
  services is assumed NTP-level and absorbed by the settlement grace; documented.

### Mock Notification service

- Consumes `order.confirmed`, `order.cancelled`, `order.expired`, `payment.refund_requested`,
  `payment.refunded`.
- Steps: insert the notification row `PENDING` (unique `(sourceEventId, channel)`), call the mock
  provider with `idempotencyKey = notification id`, mark `SENT`. Email always; SMS when a phone
  number exists. Nothing is really sent; the mock provider records and dedupes by key.
- **Guarantee:** internal records are exactly-once; external delivery is **at-least-once** (a crash
  between provider call and `SENT` resends) unless the provider honours the idempotency key.

### Messaging

- **Outbox (each schema):** `id` (uuid, also `Nats-Msg-Id`), subject, envelope, `status`
  `PENDING | PUBLISHED`, `attempts`, `lastError`, `createdAt`, `publishedAt`.
- **Relay:** every 250 ms per schema: `SELECT … WHERE status = 'PENDING' ORDER BY createdAt LIMIT 100
  FOR UPDATE SKIP LOCKED`, publish asynchronously, await all PubAcks, mark `PUBLISHED`. A publish
  error increments `attempts`/`lastError` and retries next tick. Several relays are safe. Global
  order is not guaranteed; consumers rely on `decide`, not on order.
- **Retention:** outbox rows and `processed_messages` are deleted after **14 days** (longer than the
  7-day stream `max_age`), so recovery can always reach beyond the stream.
- **Envelope:**

  ```ts
  type Envelope<T> = {
    id: string;            // uuid = outbox id = Nats-Msg-Id
    type: string;          // e.g. "order.placed"
    version: number;
    occurredAt: string;    // ISO-8601 UTC
    correlationId: string; // minted once at holdSeats, unchanged through the whole booking
    causationId: string | null; // id of the event that caused this one
    holdId?: string;
    orderId?: string;
    payload: T;
  };
  ```

- **Streams:** `TICKETARENA` (`ta.seat.>`, `ta.hold.>`, `ta.order.>`, `ta.payment.>`; limits,
  7 days, sized, `discard: new`) and `TICKETARENA_DLQ` (`ta.dlq.>`; limits, 30 days, sized,
  `discard: new`, `duplicate_window` 10 min). Server `sync_interval: always`. Created by
  `ensureTopology()` before the relay starts.
- **Event catalogue:**

  | Subject                       | Producer        | Consumers                  | Key payload                                                 |
  | ----------------------------- | --------------- | -------------------------- | ----------------------------------------------------------- |
  | `ta.seat.held`                | booking         | none (feed)                | holdId, eventId, seatIds, holdExpiresAt                     |
  | `ta.hold.released`            | booking         | none (feed)                | holdId, seatIds                                             |
  | `ta.hold.expired`             | booking         | none (feed)                | holdId, seatIds                                             |
  | `ta.order.placed`             | booking         | payment                    | orderId, amount, currency, paymentDeadline, contact         |
  | `ta.order.confirmed`          | booking         | notification               | orderId, seats, total, contact                              |
  | `ta.order.cancelled`          | booking         | notification               | orderId, reason, contact                                    |
  | `ta.order.expired`            | booking         | notification               | orderId, contact                                            |
  | `ta.payment.succeeded`        | payment         | booking-saga               | paymentId, orderId, attemptNo, amount, currency, capturedAt |
  | `ta.payment.failed`           | payment         | booking-saga               | paymentId, orderId, attemptNo, final, reason                |
  | `ta.payment.refund_requested` | booking         | payment, notification      | paymentId, orderId, amount, currency, reason, contact       |
  | `ta.payment.refunded`         | payment         | booking-saga, notification | paymentId, orderId, amount, refundedAt, contact             |
  | `ta.dlq.<consumer>`           | consumer runner | none (inspection, replay)  | original envelope, error, deliveryCount                     |

- **Consumers:** durable pull consumers `payment`, `booking-saga`, `notification`, each with its
  own filter; `AckWait` 30s, no `BackOff`, `MaxDeliver -1`.
- **Consumer runner:** DLQ gate before the handler (`deliveryCount > 5`, schema-invalid, unknown
  version → DLQ); handler outcome ack / `nak(delay)` with delays 1s, 5s, 30s, 2m by delivery count /
  dead-letter; `working()` for long handlers; a unique violation on `processed_messages` → ack as
  duplicate. DLQ routing: publish with `Nats-Msg-Id = dlq:<consumer>:<envelope id>`, await PubAck,
  then `term`; on DLQ publish failure `nak(2m)`, never `term`.
- **Delivery guarantee:** at-least-once; Postgres is the source of truth. Bounds: a consumer
  more than 7 days behind loses messages; single-node disk loss loses in-flight messages (recover
  from the outbox); a full stream rejects publishes and the outbox holds the events.

### Consumer recovery (runbook and script)

Principle: **replaying processed messages is acceptable; silently skipping unprocessed ones is not.**

1. Prefer in-place consumer update (`ensureTopology()` updates config).
2. Recreation script, given a consumer name:
   1. **Ack floor available:** read `ack_floor.stream_seq`, recreate with `by_start_sequence` at
      `ack_floor + 1`.
   2. **Ack floor unavailable, reliable contiguous checkpoint exists:** scan the retained stream
      with the consumer's filter from the first retained sequence, checking each envelope id
      against that consumer's `processed_messages`; resume at the first sequence without a row.
      `processed_messages` is reliable when its retention (14 days) covers the stream's first
      retained message; otherwise go to 3.
   3. **No reliable checkpoint:** start from the earliest retained message.
   4. Duplicates are absorbed by `processed_messages`.
   5. **Beyond stream retention:** an outbox re-publish script moves rows in a time range back to
      `PENDING`. Events older than 14 days cannot be recovered automatically.
3. Never derive a start point from a timestamp or from "highest processed sequence minus a margin".

### Waiting room

- Event schedule: `onSaleAt`, `queueOpensAt`, `queueClosesAt`. `AdmissionPolicy.isQueueActive`
  reads it; when inactive, `join` admits immediately (a token is still issued).
- Redis per event (all mutations are Lua scripts, all keys carry a configurable prefix):
  - queue ZSET: score is a random value in `[0, 1)` for joins before `onSaleAt` (injected
    `Random`), `1 + sequence` afterwards; `ZADD NX`, so refresh and second tabs keep the position.
  - token bucket: `admitRate` tokens/s, burst `admitRate`.
  - active ZSET: member `sessionId`, score `lastSeenAt`, bounded by `maxActive`.
  - admitted set: `jti` with expiry.
  - counters for booking metrics.
- **Admission ticker** (worker, every 1s): admits from the queue head while tokens and
  `maxActive` allow; admitted sessions enter the active set. The web app mints the JWT on the
  admitted session's next `queue.status` poll.
- **Admission token:** JWT HS256 (`ADMISSION_SECRET`), claims `sub = sessionId`, `eid = eventId`,
  `jti`, `exp = admittedAt + 30 min` (fixed, no renewal), in httpOnly cookie `ta_adm_<eventId>`.
- **`admittedProcedure`:** verifies signature and `exp`, `sub = principal.sessionId`,
  `eid = input.eventId`, `jti` in the admitted set; else `FORBIDDEN`. Used only by `holdSeats`.
- **Slots:** heartbeat on every admitted call and status poll (clients on seat map and checkout
  keep polling every 3s). A slot frees on order placed, `leave`, or reaping (worker, every 15s:
  `lastSeenAt` older than 90s or admission expired). Freeing a slot removes the `jti` (revokes
  admission). ETA = position / effective admit rate.
- Client polling: `queue.status` every 3s; order status every 2s.

### API (tRPC)

- Public: `events.list`, `events.get`, `seats.map`.
- Session (any principal): `queue.join`, `queue.status`, `queue.leave`, `booking.getHold`,
  `booking.releaseHold`, `booking.placeOrder`, `booking.getOrder`.
- Admitted: `booking.holdSeats`.
- Admin: `admin.snapshot`, `admin.feed(cursor)`, `admin.stuckRefunds`, `admin.retryRefund`,
  `admin.runRace`, `admin.resetDemo`.
- Domain errors are typed: `SEAT_UNAVAILABLE` (with seat ids), `LIMIT_EXCEEDED`, `BOOKING_BUSY`,
  `HOLD_EXPIRED`, `IDEMPOTENCY_KEY_REUSED`, `NOT_FOUND`, `FORBIDDEN`. Inputs validated with zod.

### Frontend (React 19, Next.js 16 App Router)

- Pages: events list → event page → queue room → seat map → checkout → order status; `/admin`.
- Seat map: a CSS grid of native HTML `<button>` elements (sections as grid areas) with
  `aria-label` and `aria-pressed`; keyboard navigable. No SVG hit-testing in the MVP.
- Hold countdown to the server's `holdExpiresAt`; checkout generates the `idempotencyKey` once per
  checkout attempt and reuses it on retries.
- Server state via TanStack Query (tRPC); Zustand only for seat selection before the hold;
  shadcn/ui components on Tailwind v4.

### Admin dashboard

- Auth: `ADMIN_PASSWORD` → signed admin cookie; `adminProcedure` and `proxy.ts` guard `/admin`.
- `admin.snapshot` polled every 1s: seats by status, orders by status, pending payments, queue
  length, active shoppers, metrics (`hold_ok`, `seat_unavailable`, `race_lost`, `booking_busy`,
  `deadlock_retry`, `limit_exceeded`, `late_delivery_refund`), outbox lag (oldest `PENDING` age),
  consumer lag, pending acks, redeliveries, DLQ size and oldest age, `refund_pending_age_max`.
  NATS figures come from the worker's health endpoint.
- Live feed: union of all outbox tables by cursor `(createdAt, id)`, groupable by `correlationId`.
- Stuck refunds list with "retry refund".
- **Run race:** demo event only; 100 synthetic sessions call `BookingService.holdSeats` on one
  seat concurrently in-process, bypassing admission on purpose (admission is a tRPC concern; the
  race exercises the booking core). Shows successes, `SEAT_UNAVAILABLE`, `BOOKING_BUSY`, duration.
- **Reset demo:** demo event only; allowed when no demo order is `PENDING_PAYMENT` and no demo
  refund obligation is open; clears demo holds, orders, ledger rows and Redis keys, and returns
  seats to `AVAILABLE`. Payment and notification history stays (no cross-schema deletes).
- Run race and reset are rate-limited to 1 per 10s.

### Observability

- `pino` JSON logs in web and worker; every line about a booking carries `correlationId` and
  `causationId`, plus `holdId` / `orderId` / `paymentId` when known.
- `correlationId` is minted once at `holdSeats` and never changes through hold, order, payment,
  refund and notification. `holdId` and `orderId` stay separate fields.
- OpenTelemetry is phase 2.

### Deployment and CI

- Vercel (web), Neon (pooled for web, direct for migrations; `prisma migrate deploy` in CI before
  web deploy), Upstash, Fly.io (worker + NATS with a volume, private network). Local Docker Compose.
- GitHub Actions from the first slice: `pnpm check` with Postgres, Redis and NATS service
  containers; required on `main`.

## Testing Decisions

### What makes a good test here

- Tests exercise **public interfaces only** (service methods, tRPC callers, the consumer runner,
  Lua-backed `QueueService` operations) and assert observable outcomes: returned results, rows in
  the database, events in the outbox or stream, notification records. No assertions on private
  functions, query shapes or call counts of our own modules.
- Only system boundaries are faked: `Clock`, `Random`, and the mock providers. Postgres, Redis and
  NATS are always real (ADR 0010).
- Concurrency tests use real parallelism (independent connections, `Promise.all`) and assert
  invariants on final state, not on interleavings.
- Every test file is isolated (own database from a migrated template, own Redis prefix, own stream
  prefix) and runs in parallel.

### Seams (highest possible; few as possible)

1. **`BookingService`** against real Postgres: holds, orders, limits, expiry, sweeper, saga
   handling, reconciler. This is the primary seam.
2. **`decide()`**, the pure saga decision function: one unit test per matrix cell.
3. **`QueueService`** against real Redis, plus a shared `QueueStore` contract suite run against
   both adapters.
4. **Consumer runner and `MessageBus`** against real NATS: retry delays, DLQ gate, dedupe, contract
   suite for the adapter.
5. **tRPC `createCaller`** for authorization: admission, ownership, admin guard, error mapping.
   Prior art: the existing health router test and server env tests.
6. **Worker end-to-end** (in-process composition of relay, payment, booking saga, notification
   against real Postgres and NATS): full saga outcomes.

### Required acceptance tests

Booking correctness

- AT-01 Hot seat: 100 concurrent `holdSeats` on one free seat → exactly 1 success; every other
  result is `SEAT_UNAVAILABLE` or `BOOKING_BUSY`; zero other errors; exactly one live hold on the
  seat. With the test's pool and timeouts sized for it, 99 `SEAT_UNAVAILABLE` is also asserted and
  the split is reported.
- AT-02 Multi-seat atomicity: overlapping multi-seat requests never leave a partial hold; each
  request gets all its seats or none.
- AT-03 Limit under concurrency: two parallel 4-seat holds by one buyer on disjoint seats → one
  success, one `LIMIT_EXCEEDED`.
- AT-04 No double counting: hold 4 → `placeOrder` → usage stays 4; a further 3-seat hold →
  `LIMIT_EXCEEDED`; after the order expires, usage drops.
- AT-05 Lock timeout and deadlock: a transaction blocked past `lock_timeout` is retried and finally
  returns `BOOKING_BUSY`; an induced deadlock is retried and succeeds.
- AT-06 Snapshot fast path: a hold on a sold seat returns `SEAT_UNAVAILABLE` without waiting on a
  lock held by another transaction; counters distinguish `seat_unavailable` from `race_lost`.

Expiry

- AT-07 Lazy expiry: a seat whose hold expired can be held by another buyer before the sweeper runs.
- AT-08 Lock-wait expiry: with the fake clock moved past `holdExpiresAt` while `placeOrder` waits
  on a lock held by the test → `HOLD_EXPIRED`.
- AT-09 `placeOrder` vs sweeper: both orders of arrival give a consistent result (order created and
  hold not expired, or `HOLD_EXPIRED` and seats freed); never both.
- AT-10 Checkout keeps seats: `IN_CHECKOUT` seats are not freed by lazy expiry or by the hold
  sweeper after the original hold expiry; they are freed only at `paymentDeadline + grace`.
- AT-11 Stale-clock takeover: `placeOrder` refuses when a seat's `holdId` no longer matches its hold.

Idempotency

- AT-12 Same `idempotencyKey`, same request → same order; concurrent duplicates → one order.
- AT-13 Same key, different request → `IDEMPOTENCY_KEY_REUSED`.
- AT-14 Duplicate payment event (`+dup@`) → one state change, one notification record.

Saga and money

- AT-15 Happy path end to end: hold → order → `payment.succeeded` → `CONFIRMED`, ledger `APPLIED`,
  seats `SOLD`, confirmation notification.
- AT-16 Final failure → `CANCELLED`, seats freed, cancellation notification.
- AT-17 Non-final failure → order stays `PENDING_PAYMENT`, seats held.
- AT-18 On time but delivered after grace → order `EXPIRED`, refund requested, `late_delivery_refund`
  incremented.
- AT-19 On time, delivered within grace → `CONFIRMED`.
- AT-20 Captured after the deadline (`+late@`) → refund, seats never reclaimed even if still free.
- AT-21 Second payment on a confirmed order (`+double@`) → second payment refunded; exactly one
  `APPLIED`.
- AT-22 Amount mismatch → refund, not confirmation.
- AT-23 Refund idempotency: duplicate `payment.refund_requested` → one refund row, one
  `payment.refunded`.
- AT-24 Reconciler: a `REFUND_REQUESTED` row older than 10 min is re-emitted; after 3 re-emits it
  becomes `MANUAL_REVIEW`; admin retry moves it back.
- AT-25 `decide()` matrix: every cell of the matrix, including poison for unknown orders/payments.

Messaging

- AT-26 Relay: committed outbox rows are published once per row (broker dedupe on replay); rows of
  a rolled-back transaction are never published.
- AT-27 Transient failure → redelivered after the scheduled delay; succeeds on a later attempt.
- AT-28 Retry budget exhausted → exactly one DLQ copy, then `term`; a simulated crash between DLQ
  publish and `term` does not create a second DLQ entry (dedupe window).
- AT-29 DLQ publish failure → message is not terminated and is redelivered.
- AT-30 Poison message → DLQ on first delivery, handler not invoked.
- AT-31 Crash after commit, before ack → redelivery acked as duplicate, no second side effect.
- AT-32 Consumer recovery, ack floor: recreate after out-of-order partial processing → every
  unprocessed message is delivered; none skipped.
- AT-33 Consumer recovery, checkpoint scan: with processed set {1, 2, 3, 5} and the consumer
  deleted → resume at 4; 5 is redelivered and deduped.
- AT-34 Consumer recovery, no checkpoint → replay from the earliest retained message with no
  duplicate side effects.
- AT-35 Topology: `ensureTopology()` is idempotent; stream subjects do not overlap; a full stream
  rejects publishes and outbox rows stay `PENDING`.

Waiting room

- AT-36 Pre-queue: joins before `onSaleAt` are all ahead of later joins, ordered by injected
  randomness; later joins are FIFO.
- AT-37 Refresh keeps position (`ZADD NX`).
- AT-38 Admission respects `admitRate` and `maxActive`.
- AT-39 Slots free on order placed, leave and reaping; freeing revokes admission.
- AT-40 Admission enforcement: `holdSeats` without a token, with an expired token, with another
  session's token, with another event's token, or with a revoked `jti` → `FORBIDDEN`.
- AT-41 `placeOrder` succeeds with an expired admission token when the hold is valid; fails for a
  hold owned by another buyer.
- AT-42 `QueueStore` contract suite passes for both adapters.

Notifications and admin

- AT-43 Each final order outcome produces exactly one notification record per channel.
- AT-44 Admin procedures reject a missing or invalid admin cookie; race and reset only touch the
  demo event and are rate-limited.
- AT-45 Run race through `admin.runRace` reports exactly one success.

### Load tests (k6, outside the gate)

- Queue storm: 5k virtual users join one event → admission never exceeds `admitRate`, no 5xx,
  refresh keeps position.
- Hot seat: 500 virtual users on 10 seats → zero oversell in the database afterwards; report the
  `SEAT_UNAVAILABLE` / `BOOKING_BUSY` split, throughput and p95/p99.
- Durability cost: the hot-seat scenario with NATS `sync_interval` default vs `always`; record relay
  publish p50/p99 and throughput.
- Run locally against Docker Compose; commands and results are recorded in the docs.

## Out of Scope

- Registration, login, per-user limits, order history, ticket management, authenticated checkout
  (phase 2, behind `IdentityService`).
- Payment retry UI ("try another card"), refunds of confirmed orders (customer cancellation),
  pre-expiry payment status reconciliation with the provider (phase 2).
- Load-based (dynamic) waiting-room activation (phase 2, behind `AdmissionPolicy`).
- Catalog CRUD, venue editor, curved or SVG seat maps.
- Real payment providers and real email/SMS delivery.
- Bot mitigation beyond the randomized pre-queue (CAPTCHA, device fingerprinting).
- OpenTelemetry tracing; multi-node NATS; multi-region.
- DLQ replay tooling beyond the outbox re-publish and consumer recreation scripts.

## Further Notes

- **Slice order:** (1) walking skeleton end to end (seeded event → hold one seat without queue →
  `placeOrder` → outbox → relay → JetStream → mock payment succeeds → `CONFIRMED` → notification
  record) **plus CI**; (2) hot seat, multi-seat atomicity, limit, lock timeouts; (3) expiry;
  (4) failure compensation, late payment, refunds and reconciler; (5) dedupe, retries, DLQ,
  recovery tooling; (6) waiting room; (7) admission enforcement; (8) frontend flow; (9) admin
  dashboard, feed, race, reset; (10) deployment and k6. Correctness core first, queue second, UI
  third.
- The Ralph sandbox image must install and start Postgres 17, Redis 7 and nats-server so every
  slice is judged on real infrastructure (ADR 0010).
- All decisions are recorded in ADRs 0004–0013; ADRs 0002 and 0003 remain in force (0008 refines
  0002, 0004 settles 0003's open broker choice).
