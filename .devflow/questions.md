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

Answer: Accepted (2026-11-18): a performance date needs a migration the MVP does not need.

## 2026-11-18 14:57 ticket 32

What is the on-sale status?

Assumed: Client-clock hint: 'On sale now' if onSaleAt is past, else 'Upcoming', always with the on-sale time; the server decides

Answer: Accepted (2026-11-18): the label is a hint; holdSeats enforces onSaleAt (ticket 61).

## 2026-11-18 14:57 ticket 32

Are unselectable seats natively disabled?

Assumed: No: aria-disabled and focusable so screen-reader and keyboard users hear their status; arrow keys move within a section, all seats stay in Tab order

Answer: Accepted (2026-11-18).

## 2026-11-18 14:57 ticket 32

Where do prices per section appear?

Assumed: Event page only; events.list contract unchanged and returns no prices

Answer: Accepted (2026-11-18).

## 2026-11-18 15:15 ticket 35

What does admin.snapshot cover, and what are pending payments?

Assumed: All events ordered by onSaleAt; seats, queue length, active shoppers and counters per event; orders by status global (orders have no eventId); pending payments = orders in PENDING_PAYMENT (ADR 0009: booking does not read the payment schema)

Answer: Accepted (2026-11-18).

## 2026-11-18 15:15 ticket 35

How is the admin cookie signed and scoped?

Assumed: HMAC with SESSION_SECRET over a ta_admin:-prefixed payload including expiry; 8h, httpOnly, Secure, SameSite=Strict; ADMIN_PASSWORD min 12 chars, constant-time compare; changing ADMIN_PASSWORD does not revoke issued cookies

Answer: Accepted (2026-11-18): an 8-hour cookie that survives a password change is acceptable for the demo.

## 2026-11-18 15:15 ticket 35

Login rate limiting and logout?

Assumed: Neither built in this ticket; form POST to /api/admin/login with 303 redirects; missing/invalid cookie is UNAUTHORIZED

Answer: Accepted (2026-11-18) for this ticket. Login rate limiting and logout must exist before the public deployment. Fix: ticket 65.

## 2026-11-18 15:33 ticket 37

What does 'results appear in the feed' mean before the feed (ticket 36) exists?

Assumed: The winning hold's normal seat.held outbox row is the race's feed entry; runRace returns its holdId and correlationId; losers write nothing; no new event type, no feed UI

Answer: Accepted (2026-11-18).

## 2026-11-18 15:33 ticket 37

What blocks the demo reset, and what does it delete?

Assumed: Blocked by PENDING_PAYMENT demo orders or order_payments with REFUND_REQUESTED or MANUAL_REVIEW; deletes demo holds, orders, order_lines, order_payments and the event's Redis keys; keeps outbox_events, processed_messages, payment and notification schemas

Answer: Overridden (2026-11-18): the reset must be conservative and keep financial audit history. It never deletes orders, order lines or ledger rows, so a delayed, duplicate or late payment always finds its order and is reconciled by the saga; it still refuses while a demo order is PENDING_PAYMENT or a refund obligation is open. Until a safe cleanup mechanism exists, nothing financial is deleted. Fix: ticket 64.

## 2026-11-18 15:33 ticket 37

How is the 1-per-10s limit stored and enforced?

Assumed: SET admin:rate:<action> NX PX 10000 on the shared Upstash store, global per action, taken before other checks, fails closed; refusal is TOO_MANY_REQUESTS with retry seconds

Answer: Accepted (2026-11-18).

## 2026-11-18 15:53 ticket 44

AC1 names Prisma's default 5 s timeout; must the test sleep over 5 s?

Assumed: No: the test injects a 500 ms runner transaction timeout and a 900 ms real sleep; it fails on the old code, so it proves the bug without a 5 s wait

Answer: Accepted (2026-11-18): the test proves the bug without a 5 s wait.

## 2026-11-18 15:53 ticket 44

Does the notification handler's provider.send (also fingerprinted by TD-051) move out of the transaction too?

Assumed: No: it needs a reworked pending/send/resume flow the ACs don't cover; left as a follow-up

Answer: Accepted (2026-11-18) for this ticket. The notification send still runs inside the transaction (the rest of TD-051). Fix: ticket 66.

## 2026-11-18 17:44 ticket 17

What does the apply step do for decisions whose side effects later tickets build (late/mismatched payment refunds, payments on non-pending orders)?

Assumed: decide returns the spec's answer; the handler throws 'not handled yet' so the runner retries on the delay schedule (today's behaviour, never drops captured money); tickets 19 and 22 replace the throw

Answer: Accepted (2026-11-18): captured money is never dropped; tickets 19 and 22 replace the throw.

## 2026-11-18 17:44 ticket 17

How does poison behave before the DLQ (ticket 25) exists?

Assumed: Roll back, log as error, nak on the normal delay schedule; ADR 0011 forbids term without a confirmed DLQ copy

Answer: Accepted (2026-11-18): ADR 0011 forbids term without a confirmed DLQ copy.

## 2026-11-18 17:44 ticket 17

A demo reset can delete an EXPIRED/CANCELLED order; a later payment.succeeded then hits an unknown orderId. Poison or refund?

Assumed: Poison, per the spec and ticket; docs/database/index.md now leaves refund-vs-poison open for the late-payment ticket. A human should decide whether the spec needs a demo-reset exception

Answer: Overridden (2026-11-18): refund, not poison. A captured payment.succeeded whose order no longer exists must eventually be refunded, safely and idempotently (one refund per paymentId, however often it is redelivered). Ticket 17 is unchanged; ticket 19 builds it and updates the spec. Ticket 64 makes the case rare by keeping orders on a demo reset.

## 2026-11-18 17:44 ticket 17

Matrix gaps the spec leaves open?

Assumed: refunded with APPLIED ledger -> noop refund_not_requested; final failed on PENDING with APPLIED -> noop payment_applied; late and mismatched on PENDING -> late rule wins (EXPIRED + refund); on-time payment on EXPIRED order -> refund reason late_delivery

Answer: Accepted (2026-11-18): every gap resolves towards returning the money.

## 2026-11-18 22:20 ticket 61

Which tRPC code does NOT_ON_SALE map to, and is a hold at exactly onSaleAt allowed?

Assumed: PRECONDITION_FAILED (time precondition, like HOLD_EXPIRED); 'before' is strict, so a hold at exactly onSaleAt succeeds, matching the ticker's now < onSaleAt rule

Answer: Accepted (2026-11-19): matches the ticker rule now < onSaleAt.

## 2026-11-18 22:20 ticket 61

How do the demo event and admin.runRace keep working once holds before onSaleAt are refused?

Assumed: Seed puts the demo event on sale 1 day before seeding (queue already closed, join stays ADMISSIBLE); existing databases keep the old future onSaleAt and need a reset and re-seed (noted in docs/database/index.md)

Answer: Accepted (2026-11-19).

## 2026-11-18 22:20 ticket 61

ADR 0008 says 'outside the queue window the policy admits immediately'. Edit or supersede it?

Assumed: Left the accepted ADR unchanged; it now reads as 'after the queue closes' per the ticket 28 answer. A human may add a clarifying note or a superseding ADR

Answer: Accepted (2026-11-19), with a clarifying amendment to ADR 0008 (the queue phases: NOT_OPEN before queueOpensAt, immediate admission only after queueClosesAt, no hold before onSaleAt).

## 2026-11-19 07:26 ticket 62

What does join return for a slot holder, and in which order are phase and slot checked?

Assumed: { status: 'ADMITTED' } (QueueStore.join returns JoinOutcome QUEUED|ADMITTED); the phase is checked first, so NOT_OPEN and ADMISSIBLE answer without looking at slots and write nothing; only an open queue answers ADMITTED

Answer: Accepted (2026-11-19).

## 2026-11-19 07:26 ticket 62

Does a join by a slot holder count as a heartbeat?

Assumed: No: lastSeenAt is unchanged; status polls and admitted calls keep the slot alive

Answer: Accepted (2026-11-19): status polls keep the slot alive.

## 2026-11-19 08:15 ticket 31

Where does admittedProcedure get the eventId for the eid check?

Assumed: From holdSeats' existing explicit eventId input; the booking core already refuses seats of another event, so an admission to A can never hold B's seats

Answer: Accepted (2026-11-19): the booking core refuses another event's seats anyway.

## 2026-11-19 08:15 ticket 31

How do buyers hold seats when the queue is CLOSED (join answers ADMISSIBLE, e.g. the demo event)?

Assumed: join after close now admits at once via an atomic QueueStore.admitImmediately (slot + jti, 30 min, bypasses token bucket and maxActive; keeps an existing jti); the next status poll mints the token, so every buyer path goes join -> status -> token. admin.runRace stays a deliberate adminProcedure bypass. This changes ticket 61's 'ADMISSIBLE writes nothing'

Answer: Accepted (2026-11-19): immediate admission after the queue closes is the spec's rule; the ADR 0008 amendment records it.

## 2026-11-19 08:15 ticket 31

What happens to holds when Redis is down?

Assumed: The admitted-set check fails closed: holds fail with Redis down; placeOrder does not need Redis

Answer: Overridden (2026-11-19): fail open on revocation only. Signature, the HS256 algorithm, exp, sessionId and eventId are always checked. Only when Redis is unreachable may the jti revocation check be skipped; when Redis is reachable, a missing or revoked jti is FORBIDDEN. During an outage a revoked token can stay usable until its fixed expiry, and no new admission is issued. Fix: ticket 63, with tests and an ADR 0008 amendment.

## 2026-11-19 08:15 ticket 31

Which JWT library?

Assumed: jose 6.2.17 added to apps/web, pinned exactly; the repo had none

Answer: Accepted (2026-11-19).

## 2026-11-19 08:30 ticket 33

Where does the queue room live and when does it poll?

Assumed: A step on /events/[eventId]; status every 3 s only while QUEUED or ADMITTED (also during a hold, as the heartbeat, with seats.map); no checkout page yet, so the active hold is the checkout step; no leave-queue button

Answer: Accepted (2026-11-19).

## 2026-11-19 08:30 ticket 33

How does the client tell SEAT_UNAVAILABLE from LIMIT_EXCEEDED, both tRPC CONFLICT?

Assumed: It reads the domain-code prefix and taken seat ids from the error message; a typed server error formatter would be sturdier (follow-up)

Answer: Accepted (2026-11-19) for now; parsing messages is fragile. Fix: ticket 67 (typed domain error codes).

## 2026-11-19 08:30 ticket 33

Countdown skew and expiry?

Assumed: Server holdExpiresAt measured on the client clock; at 0:00 the hold leaves the page, an alert shows and the seat map refreshes; the server alone decides expiry. The hold lives only in the mutation result, so a reload loses it

Answer: Accepted (2026-11-19) for now; a reload must not hide a live hold that still counts against the buyer limit. Fix: ticket 68.

## 2026-11-19 08:40 ticket 34

booking.getOrder exposes no payment or refund data; what 'refund information' does the order status page show?

Assumed: A fixed note per final state stating the system's refund promise (overpayment on CONFIRMED, any charge on CANCELLED/EXPIRED is refunded automatically, with emails); the server contract is unchanged. Showing a real refund's progress needs getOrder to expose the payment ledger: a follow-up ticket for a human to decide

Answer: Accepted (2026-11-19); showing real refund progress waits for tickets 19 to 22.

## 2026-11-19 08:40 ticket 34

What is a checkout attempt for the idempotencyKey?

Assumed: One hold plus the trimmed contact submitted; crypto.randomUUID on first submit, reused on resubmit of the same contact; a changed contact or new hold gets a new key; dropped after IDEMPOTENCY_KEY_REUSED. A lost response then changed email yields HOLD_NOT_ACTIVE (generic message)

Answer: Accepted (2026-11-19).

## 2026-11-19 08:40 ticket 34

Where do checkout and order status live?

Assumed: Checkout inline in the hold area on /events/[eventId] (heartbeat keeps running); order status at /orders/[orderId], also shown in place of the hold after placeOrder; polling every 2 s only while PENDING_PAYMENT

Answer: Accepted (2026-11-19).

## 2026-11-20 18:03 ticket 18

How does a non-final failure arise when the MVP has one attempt per order?

Assumed: A random draw at or above successRate fails non-finally (provider_declined); +fail@ is final (card_declined). successRate defaults to 1 and is set only via createServiceConsumers({ paymentSuccessRate }); no worker env variable yet

Answer: Accepted (2026-11-21).

## 2026-11-20 18:03 ticket 18

How is 'never final while another attempt is live' enforced and tested with one attempt per order?

Assumed: Before emitting final, the handler counts other ATTEMPTING/CAPTURED attempts for the order under a per-order advisory lock; the module test inserts an attempt 2 to stand in for a concurrent retry

Answer: Superseded by the 18:07 answer below: the advisory lock was removed after review (2026-11-21).

## 2026-11-20 18:03 ticket 18

Where does the non-final failure metric live?

Assumed: A separate SagaMetrics port with one counter payment_attempt_failed in the same per-event Redis hash, not part of BookingMetric; not shown on the admin dashboard yet; fire-and-forget, so a rolled-back and retried message can over-count

Answer: Accepted (2026-11-21); an approximate metric: it is incremented before commit, so a rollback or retry can over-count.

## 2026-11-20 18:03 ticket 18

What reasons can order.cancelled carry, and does the hold change status?

Assumed: reason is z.enum(['payment_failed']), extendable later; the hold stays ORDERED, as when the sweeper expires an order

Answer: Accepted (2026-11-21).

## 2026-11-20 18:03 ticket 18

Where does the saga get the eventId for the counter, since orders has no eventId?

Assumed: The order-lock query joins holds and locks FOR UPDATE OF o

Answer: Accepted (2026-11-21).

## 2026-11-20 18:07 ticket 18

After review: does the payment handler lock attempts per order?

Assumed: No. The advisory lock was removed; the final check sees committed attempts only, which suffices while the MVP writes only attempt 1 (unique (orderId, attemptNo)). Retries must first serialize attempts per order in every branch. Supersedes the earlier advisory-lock assumption

Answer: Accepted (2026-11-21). Before retries are introduced, every attempt branch must be serialized per order; the (orderId, attemptNo) index alone allows attempts 1 and 2 together.

## 2026-11-21 10:59 ticket 19

How does +late@ capture after the deadline without the handler waiting?

Assumed: The attempt always captures with capturedAt = order.paymentDeadline + 1 s (provider time), delivered at once, so the saga sees a late capture on a still-open order

Answer: (open)

## 2026-11-21 10:59 ticket 19

Where is the refund obligation for an unknown order, given the ledger has a FK to orders?

Assumed: No ledger row; the payment.refund_requested outbox row (reason unknown_order, no contact) is the obligation, written only if none exists for that paymentId, serialized by a per-paymentId advisory xact lock. The future reconciler, which scans ledger rows, will not re-emit it (documented)

Answer: (open)

## 2026-11-21 10:59 ticket 19

What is the shape of payment.refund_requested?

Assumed: paymentId, orderId, amount, currency, reason (late_capture|late_delivery|order_expired|order_cancelled|order_confirmed|amount_mismatch|unknown_order), contact optional only for unknown_order; aggregate order_payment/paymentId v1; no consumer yet

Answer: (open)

## 2026-11-21 10:59 ticket 19

Do refund decisions for CONFIRMED orders and amount mismatches keep throwing 'not handled yet' until ticket 22?

Assumed: No: the refund apply step is generic, so they now get a refund obligation instead of retrying forever; +double@, AT-21, AT-22 remain ticket 22

Answer: (open)

## 2026-11-21 10:59 ticket 19

Add the late_delivery_refund counter now?

Assumed: Yes, as a SagaMetric counted best-effort for a late_delivery refund

Answer: (open)

## 2026-11-21 10:59 ticket 19

After a late capture, what is the hold status?

Assumed: Stays ORDERED, as when the sweeper expires an order; order.expired carries the same payload with causationId = the payment.succeeded

Answer: (open)

## 2026-11-21 11:47 ticket 20

How is payment.refunded handled when its order no longer exists (unknown_order refund, no ledger row)?

Assumed: The saga checks booking's own outbox for a payment.refund_requested with that paymentId: if present, a logged noop (unknown_order_refunded); otherwise poison (unknown_order). Passed to decide() via optional DecideContext.refundRequested

Answer: (open)

## 2026-11-21 11:47 ticket 20

What does payment.refunded carry when the request had no contact?

Assumed: contact is optional, copied from the request; absent only for unknown_order; the refund still executes

Answer: (open)

## 2026-11-21 11:47 ticket 20

Matrix says refunded on PENDING_PAYMENT is poison, but an amount-mismatch refund leaves the order PENDING_PAYMENT with a REFUND_REQUESTED row

Assumed: Matrix gap: the ledger row moves to REFUNDED whatever the order status; PENDING_PAYMENT stays poison (refund_for_pending_order) only when the payment is not in the ledger; spec matrix updated

Answer: (open)

## 2026-11-21 11:47 ticket 20

What does a duplicate payment.refund_requested do on the Payment side?

Assumed: Insert ON CONFLICT DO NOTHING; nothing refunded or emitted again, logged and acked. A future reconciler re-emit for an executed payment yields no second payment.refunded; recovery relies on the first payment.refunded in the payment outbox

Answer: (open)

## 2026-11-21 11:47 ticket 20

What goes in a payment.refunds row and in payment.refunded?

Assumed: Row: paymentId PK, orderId, amount, currency, reason, refundedAt (injected clock); no check against payment attempts; payment.refunded adds currency, aggregate payment/paymentId

Answer: (open)

## 2026-11-21 11:47 ticket 20

Does booking emit anything or notify the buyer when a refund completes?

Assumed: No; the ledger update emits nothing; refund emails are a later ticket

Answer: (open)

## 2026-11-21 11:57 ticket 21

What happens to a refund event without a contact (unknown_order)?

Assumed: Acked and logged at info, no notification record; a retry could never supply a recipient

Answer: (open)

## 2026-11-21 11:57 ticket 21

What does 'duplicate delivery' cover in AT-43?

Assumed: A redelivery of the same message and a copy of the same event under a new message id; dedupe is by sourceEventId. A future reconciler re-emit of payment.refund_requested under a new event id would send a second refund-initiated notification (documented)

Answer: (open)

## 2026-11-21 11:57 ticket 21

What do refund notifications contain and how are the consumers named?

Assumed: Templates refund-initiated and refund-completed only (email always, SMS with a phone); consumers notification-refund-requested and notification-refunded

Answer: (open)

## 2026-11-21 18:59 ticket 22

How is +double@ stored in payment storage?

Assumed: Two CAPTURED payment_attempts rows (attempt 1 and 2), each with its own paymentId and payment.succeeded, both on time, written in the one order.placed transaction (serialized per order); unique (orderId, attemptNo) unchanged; always captures regardless of the random draw

Answer: (open)

## 2026-11-21 19:05 ticket 22

How do AT-18/AT-19 control delivery time and the grace?

Assumed: One injected clock for the sweeper and the saga stands for delivery time; capturedAt comes from a hand-built event; AT-18 delivers at deadline + 61 s after the sweeper expired the order, AT-19 at + 59 s; grace stays a fixed 60 s

Answer: (open)

## 2026-11-21 19:11 ticket 22

How is the AT-22 mismatch produced?

Assumed: A hand-built payment.succeeded with amount = total - 1 or currency HUF; no new magic email

Answer: (open)

## 2026-11-21 19:17 ticket 22

Does anything enforce the grace boundary exactly?

Assumed: No: an on-time capture delivered just after the grace still confirms if the 15 s sweeper has not reached the order; documented as best-effort; AT-18 means 'the sweeper has already expired the order'

Answer: (open)
