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

Answer: Accepted (2026-11-18).

## 2026-11-18 12:40 ticket 15

What does the order.expired payload carry?

Assumed: { orderId, contact } per the spec event catalogue; order's correlationId, causationId null; no seatIds

Answer: Accepted (2026-11-18).

## 2026-11-18 12:40 ticket 15

Add an index on orders(status, paymentDeadline) for the sweep?

Assumed: No migration in ticket 15; the sweep scans orders

Answer: Accepted (2026-11-18) for the MVP; revisit with the k6 load test if the order sweep shows up.

## 2026-11-18 12:46 ticket 16

What is the canonical request for requestHash?

Assumed: hold id, email, phone (null when absent) in fixed order; email not normalized (no lowercase/trim)

Answer: Accepted (2026-11-18): stricter is the safe direction.

## 2026-11-18 12:58 ticket 28

How does the web app reach Redis for the queue?

Assumed: node-redis via a new REDIS_URL (parseQueueEnv in parseServerEnv), lazy single connection; ticket 29 may replace it with the Upstash adapter

Answer: Accepted (2026-11-18).

## 2026-11-18 12:58 ticket 28

What does join return before queueOpensAt?

Assumed: ADMISSIBLE, following the spec's 'when inactive, join admits immediately'; the window is [queueOpensAt, queueClosesAt); change in AdmissionPolicy if wrong

Answer: Overridden (2026-11-18): "inactive" in the spec means after the queue closes, not before it opens. Before queueOpensAt, join answers NOT_OPEN and issues no admission; otherwise a buyer joining just before the queue opens gets a 30-minute token that skips the randomized pre-queue (ADR 0008). holdSeats also refuses before onSaleAt. Fix: ticket 61.

## 2026-11-18 12:58 ticket 28

How is the ETA computed?

Assumed: etaSeconds = ceil(position / admitRatePerSecond), 1-based position, constant 10/s until ticket 30

Answer: Accepted (2026-11-18).

## 2026-11-18 12:58 ticket 28

Queue key names and member id?

Assumed: <prefix>waiting-room:{eventId}:queue and :seq (hash tag for one cluster slot); member = principal.sessionId; later joins score 1 + INCR (first later join scores 2)

Answer: Accepted (2026-11-18).

## 2026-11-18 13:02 ticket 29

AC2 needs CI to provide an Upstash-compatible HTTP endpoint, but .github/workflows/ci.yml (where CI sets TEST_* vars) is protected. How is it provided?

Assumed: Add a serverless-redis-http (SRH) service in front of the existing Redis to docker-compose.yml (CI already starts services from it); the test harness reads TEST_UPSTASH_REDIS_REST_URL/TOKEN and falls back to the compose defaults, so ci.yml stays untouched

Answer: Accepted (2026-11-18): the compose service keeps CI and local infrastructure in one definition.

## 2026-11-18 13:39 ticket 30

Where do admitRate and maxActive come from?

Assumed: Worker config ADMIT_RATE_PER_SECOND (default 10) and MAX_ACTIVE (default 100) in parseWorkerEnv, applied to every event; no per-event columns or migration

Answer: Accepted (2026-11-18): per-event rates are not needed for the MVP.

## 2026-11-18 13:39 ticket 30

What is the admission jti before ticket 31's token exists?

Assumed: Ticker mints a UUID jti; Redis keeps session->jti (:admission hash) and jti->expiry (:admitted ZSET, admittedAt + 30 min); freeing removes both atomically; JWT minting left to ticket 31

Answer: Accepted (2026-11-18): ticket 31 mints the JWT around this jti.

## 2026-11-18 13:39 ticket 30

Where is the slot freed on order placement?

Assumed: In the web booking.placeOrder router after the order commits, best-effort (Redis failure logged, order unaffected); holdSeats sends a best-effort heartbeat

Answer: Accepted (2026-11-18): a lost free is bounded by the 30-minute admission expiry.

## 2026-11-18 14:57 ticket 32

The catalog has no performance date; what date do the event pages show?

Assumed: The on-sale time (onSaleAt); adding a performance date needs a schema migration and contract change

Answer: (open)

## 2026-11-18 14:57 ticket 32

What is the on-sale status?

Assumed: Client-clock hint: 'On sale now' if onSaleAt is past, else 'Upcoming', always with the on-sale time; the server decides

Answer: (open)

## 2026-11-18 14:57 ticket 32

Are unselectable seats natively disabled?

Assumed: No: aria-disabled and focusable so screen-reader and keyboard users hear their status; arrow keys move within a section, all seats stay in Tab order

Answer: (open)

## 2026-11-18 14:57 ticket 32

Where do prices per section appear?

Assumed: Event page only; events.list contract unchanged and returns no prices

Answer: (open)

## 2026-11-18 15:15 ticket 35

What does admin.snapshot cover, and what are pending payments?

Assumed: All events ordered by onSaleAt; seats, queue length, active shoppers and counters per event; orders by status global (orders have no eventId); pending payments = orders in PENDING_PAYMENT (ADR 0009: booking does not read the payment schema)

Answer: (open)

## 2026-11-18 15:15 ticket 35

How is the admin cookie signed and scoped?

Assumed: HMAC with SESSION_SECRET over a ta_admin:-prefixed payload including expiry; 8h, httpOnly, Secure, SameSite=Strict; ADMIN_PASSWORD min 12 chars, constant-time compare; changing ADMIN_PASSWORD does not revoke issued cookies

Answer: (open)

## 2026-11-18 15:15 ticket 35

Login rate limiting and logout?

Assumed: Neither built in this ticket; form POST to /api/admin/login with 303 redirects; missing/invalid cookie is UNAUTHORIZED

Answer: (open)

## 2026-11-18 15:33 ticket 37

What does 'results appear in the feed' mean before the feed (ticket 36) exists?

Assumed: The winning hold's normal seat.held outbox row is the race's feed entry; runRace returns its holdId and correlationId; losers write nothing; no new event type, no feed UI

Answer: (open)

## 2026-11-18 15:33 ticket 37

What blocks the demo reset, and what does it delete?

Assumed: Blocked by PENDING_PAYMENT demo orders or order_payments with REFUND_REQUESTED or MANUAL_REVIEW; deletes demo holds, orders, order_lines, order_payments and the event's Redis keys; keeps outbox_events, processed_messages, payment and notification schemas

Answer: (open)

## 2026-11-18 15:33 ticket 37

How is the 1-per-10s limit stored and enforced?

Assumed: SET admin:rate:<action> NX PX 10000 on the shared Upstash store, global per action, taken before other checks, fails closed; refusal is TOO_MANY_REQUESTS with retry seconds

Answer: (open)

## 2026-11-18 15:53 ticket 44

AC1 names Prisma's default 5 s timeout; must the test sleep over 5 s?

Assumed: No: the test injects a 500 ms runner transaction timeout and a 900 ms real sleep; it fails on the old code, so it proves the bug without a 5 s wait

Answer: (open)

## 2026-11-18 15:53 ticket 44

Does the notification handler's provider.send (also fingerprinted by TD-051) move out of the transaction too?

Assumed: No: it needs a reworked pending/send/resume flow the ACs don't cover; left as a follow-up

Answer: (open)
