# Open questions

The agent assumed the answer below and continued. Edit `Answer:` to
override it; the next run reads this file.

## 2026-11-18 10:04 ticket 13

Which error does releaseHold give for a hold that is not HELD?

Assumed: HOLD_NOT_ACTIVE / tRPC CONFLICT, as placeOrder does

Answer: Accepted (2026-11-18): HOLD_NOT_ACTIVE / CONFLICT for any status other than HELD and EXPIRED.

## 2026-11-18 10:04 ticket 13

Can a hold that expired but has not been swept yet be released?

Assumed: Yes: it is still HELD, so release succeeds

Answer: Overridden (2026-11-18): no. A hold is valid iff T < holdExpiresAt everywhere, so releaseHold answers HOLD_EXPIRED for an expired hold, swept or not, as placeOrder does. Fix: ticket 60.

## 2026-11-18 10:04 ticket 13

What does the hold.released payload carry?

Assumed: { holdId, seatIds } with seatIds = seats actually freed (may be empty), hold's correlationId, causationId null

Answer: Accepted (2026-11-18).

## 2026-11-18 10:05 ticket 14

AC8 asks to mark TD-013 RESOLVED in docs/technical-debt.md, but CLAUDE.md says that register is frozen and not updated by runs. Which wins?

Assumed: CLAUDE.md wins: the register is not edited; AC8 is satisfied by the AT-07 and lazy-expiry tests, named in the commit message, and a human updates TD-013 if wanted

Answer: Accepted (2026-11-18): CLAUDE.md wins. A human closed TD-013 with the tests named in commit d21ab7a.

## 2026-11-18 10:05 ticket 14

Ticket 13 lets an expired-but-unswept HELD hold be released; ticket 14 says a hold is valid iff T < holdExpiresAt everywhere. Should releaseHold change?

Assumed: No change in ticket 14: releaseHold stays as ticket 13 built it (the seats end AVAILABLE either way); revisit if the answer to ticket 13's question says otherwise

Answer: Overridden (2026-11-18): yes, see the second question of ticket 13. Fix: ticket 60.

## 2026-11-18 12:40 ticket 15

Where does order expiry run, and as which consumer does Notification receive order.expired?

Assumed: Inside BookingService.sweepExpired() after holds (batches of 100); Notification gets a second durable consumer notification-expired on ta.order.expired, template order-expiry

Answer: (open)

## 2026-11-18 12:40 ticket 15

What does the order.expired payload carry?

Assumed: { orderId, contact } per the spec event catalogue; order's correlationId, causationId null; no seatIds

Answer: (open)

## 2026-11-18 12:40 ticket 15

Add an index on orders(status, paymentDeadline) for the sweep?

Assumed: No migration in ticket 15; the sweep scans orders

Answer: (open)

## 2026-11-18 12:46 ticket 16

What is the canonical request for requestHash?

Assumed: hold id, email, phone (null when absent) in fixed order; email not normalized (no lowercase/trim)

Answer: (open)

## 2026-11-18 12:58 ticket 28

How does the web app reach Redis for the queue?

Assumed: node-redis via a new REDIS_URL (parseQueueEnv in parseServerEnv), lazy single connection; ticket 29 may replace it with the Upstash adapter

Answer: (open)

## 2026-11-18 12:58 ticket 28

What does join return before queueOpensAt?

Assumed: ADMISSIBLE, following the spec's 'when inactive, join admits immediately'; the window is [queueOpensAt, queueClosesAt); change in AdmissionPolicy if wrong

Answer: (open)

## 2026-11-18 12:58 ticket 28

How is the ETA computed?

Assumed: etaSeconds = ceil(position / admitRatePerSecond), 1-based position, constant 10/s until ticket 30

Answer: (open)

## 2026-11-18 12:58 ticket 28

Queue key names and member id?

Assumed: <prefix>waiting-room:{eventId}:queue and :seq (hash tag for one cluster slot); member = principal.sessionId; later joins score 1 + INCR (first later join scores 2)

Answer: (open)
