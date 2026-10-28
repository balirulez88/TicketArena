# Glossary

[← System map](index.md)

Use these terms exactly in code, tests, tickets and specs. Add a term when a slice introduces it.

| Term                  | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Event**             | A performance (concert, match) with a venue, date and seat inventory. Not a domain event. |
| **On-sale**           | The moment an Event's tickets become purchasable; the traffic spike begins.               |
| **Waiting room**      | The queue buyers enter before an on-sale or under load, before they may reach checkout.   |
| **Admission**         | Moving a buyer from the waiting room to checkout by granting a time-limited token.        |
| **Admission token**   | Proof a buyer was admitted; required by booking procedures; expires.                      |
| **Hold**              | A temporary, exclusive reservation of seat(s) for one buyer during checkout; expires.     |
| **Booking**           | A confirmed purchase of held seats. The point at which a seat is sold.                    |
| **Oversell**          | Selling the same seat twice. Must be impossible, not merely unlikely.                     |
| **Integration event** | A fact published to other services via the outbox (e.g. `booking.confirmed`).             |
| **Outbox**            | The `outbox_events` table; integration events committed atomically with business data.    |
| **Relay**             | The process that publishes PENDING outbox rows to the broker.                             |
| **Slice**             | One tracer-bullet ticket: a thin, complete path through every layer, green on its own.    |
| **Seam**              | A public interface where tests observe behaviour without reaching inside.                 |
