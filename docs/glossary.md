# Glossary

[← System map](index.md)

Use these terms exactly in code, tests, tickets and specs. Add a term when a slice introduces it.

| Term                  | Meaning                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **Event**             | A performance (concert, match) with a venue, date and seat inventory. Not a domain event.          |
| **On-sale**           | The moment an Event's tickets become purchasable; the traffic spike begins.                        |
| **Waiting room**      | The queue buyers enter before an on-sale or under load, before they may reach checkout.            |
| **Admission**         | Moving a buyer from the waiting room to checkout by granting a time-limited token.                 |
| **Admission token**   | Proof a buyer was admitted; required by booking procedures; expires.                               |
| **Hold**              | A temporary, exclusive reservation of seat(s) for one buyer during checkout; expires.              |
| **Booking**           | A confirmed purchase of held seats. The point at which a seat is sold.                             |
| **Pre-queue**         | Buyers who joined before `onSaleAt`; they get random positions ahead of later joiners.             |
| **Active shopper**    | An admitted session holding one of the event's `maxActive` slots.                                  |
| **Principal**         | Who is calling: a guest session now, a user later. Resolved by `IdentityService`.                  |
| **BuyerKey**          | a user's `userId`, else the guest `sessionId`; the key for ticket limits and ownership.            |
| **Order**             | A checkout of one hold: `PENDING_PAYMENT` → `CONFIRMED`, `CANCELLED` or `EXPIRED`.                 |
| **Payment deadline**  | Fixed `placeOrder` time + 5 min; a payment is on time iff `capturedAt` ≤ it.                       |
| **Settlement grace**  | 60s after the payment deadline before the sweeper expires an order. Best-effort.                   |
| **Payment attempt**   | One try to charge an order, owned by the payment service; may fail non-finally.                    |
| **Order payment**     | A captured payment in the booking ledger, with a disposition (`APPLIED`, `REFUND_REQUESTED`, ...). |
| **Refund obligation** | A `REFUND_REQUESTED` ledger row; retried by the reconciler until refunded or escalated.            |
| **Sweeper**           | Worker job that expires holds and overdue orders and frees their seats.                            |
| **Reconciler**        | Worker job that re-emits stale refund obligations and escalates them to manual review.             |
| **Correlation id**    | Minted once at `holdSeats`; unchanged across hold, order, payment, refund, notification.           |
| **Causation id**      | The id of the event that caused the current event.                                                 |
| **DLQ**               | Dead-letter stream `TICKETARENA_DLQ` for messages past their retry budget or poison.               |
| **Ack floor**         | The stream sequence up to which a consumer has acked everything; the safe resume point.            |
| **Race lost**         | A hold refused because another buyer locked the seat first: a prevented double booking.            |
| **Oversell**          | Selling the same seat twice. Must be impossible, not merely unlikely.                              |
| **Integration event** | A fact published to other services via the outbox (e.g. `order.confirmed`).                        |
| **Outbox**            | The `outbox_events` table; integration events committed atomically with business data.             |
| **Relay**             | The process that publishes PENDING outbox rows to the broker.                                      |
| **Slice**             | One tracer-bullet ticket: a thin, complete path through every layer, green on its own.             |
| **Seam**              | A public interface where tests observe behaviour without reaching inside.                          |
