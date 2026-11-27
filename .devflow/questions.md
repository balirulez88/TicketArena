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

Answer: Accepted (2026-11-22): a mock with capturedAt = paymentDeadline + 1 s, delivered at once; the simulated provider time is documented.

## 2026-11-21 10:59 ticket 19

Where is the refund obligation for an unknown order, given the ledger has a FK to orders?

Assumed: No ledger row; the payment.refund_requested outbox row (reason unknown_order, no contact) is the obligation, written only if none exists for that paymentId, serialized by a per-paymentId advisory xact lock. The future reconciler, which scans ledger rows, will not re-emit it (documented)

Answer: Not accepted as the durable design (2026-11-22): an outbox row alone is deleted by the 14-day retention while the refund may be open. Needs a booking-owned obligation unique by paymentId, storable without an order FK, with a closable state that recovery also covers. Interim until then.

## 2026-11-21 10:59 ticket 19

What is the shape of payment.refund_requested?

Assumed: paymentId, orderId, amount, currency, reason (late_capture|late_delivery|order_expired|order_cancelled|order_confirmed|amount_mismatch|unknown_order), contact optional only for unknown_order; aggregate order_payment/paymentId v1; no consumer yet

Answer: Accepted (2026-11-22), with one change made in review: contact may be absent only for unknown_order, and the schema enforces it (discriminated union on reason).

## 2026-11-21 10:59 ticket 19

Do refund decisions for CONFIRMED orders and amount mismatches keep throwing 'not handled yet' until ticket 22?

Assumed: No: the refund apply step is generic, so they now get a refund obligation instead of retrying forever; +double@, AT-21, AT-22 remain ticket 22

Answer: Accepted (2026-11-22): the shared refund path handles CONFIRMED and amount-mismatch now; ticket 22 keeps its own tests and demo.

## 2026-11-21 10:59 ticket 19

Add the late_delivery_refund counter now?

Assumed: Yes, as a SagaMetric counted best-effort for a late_delivery refund

Answer: Accepted (2026-11-22): best-effort, approximate metric; over-counting under rollback or retry is a documented limit.

## 2026-11-21 10:59 ticket 19

After a late capture, what is the hold status?

Assumed: Stays ORDERED, as when the sweeper expires an order; order.expired carries the same payload with causationId = the payment.succeeded

Answer: Accepted (2026-11-22): the hold stays ORDERED; the order is EXPIRED, the seats are freed, and order.expired has the payment.succeeded event as causationId.

## 2026-11-21 11:47 ticket 20

How is payment.refunded handled when its order no longer exists (unknown_order refund, no ledger row)?

Assumed: The saga checks booking's own outbox for a payment.refund_requested with that paymentId: if present, a logged noop (unknown_order_refunded); otherwise poison (unknown_order). Passed to decide() via optional DecideContext.refundRequested

Answer: Accepted as interim (2026-11-22): a logged noop when booking's outbox proves the request, else poison. The durable orphan obligation must be closed here once it exists.

## 2026-11-21 11:47 ticket 20

What does payment.refunded carry when the request had no contact?

Assumed: contact is optional, copied from the request; absent only for unknown_order; the refund still executes

Answer: Accepted (2026-11-22) for unknown_order: contact is copied from the request, and a missing contact never blocks executing the refund.

## 2026-11-21 11:47 ticket 20

Matrix says refunded on PENDING_PAYMENT is poison, but an amount-mismatch refund leaves the order PENDING_PAYMENT with a REFUND_REQUESTED row

Assumed: Matrix gap: the ledger row moves to REFUNDED whatever the order status; PENDING_PAYMENT stays poison (refund_for_pending_order) only when the payment is not in the ledger; spec matrix updated

Answer: Accepted (2026-11-22): the REFUND_REQUESTED or MANUAL_REVIEW ledger row closes to REFUNDED whatever the order status; the order is unchanged; an unknown paymentId is poison.

## 2026-11-21 11:47 ticket 20

What does a duplicate payment.refund_requested do on the Payment side?

Assumed: Insert ON CONFLICT DO NOTHING; nothing refunded or emitted again, logged and acked. A future reconciler re-emit for an executed payment yields no second payment.refunded; recovery relies on the first payment.refunded in the payment outbox

Answer: Accepted (2026-11-22): one refund and one completion event; recovering an emitted completion relies on the outbox.

## 2026-11-21 11:47 ticket 20

What goes in a payment.refunds row and in payment.refunded?

Assumed: Row: paymentId PK, orderId, amount, currency, reason, refundedAt (injected clock); no check against payment attempts; payment.refunded adds currency, aggregate payment/paymentId

Answer: Accepted (2026-11-22): the proposed fields, with currency on the completion. No separate capture or amount check is acceptable for the mock MVP; revisit for a real provider.

## 2026-11-21 11:47 ticket 20

Does booking emit anything or notify the buyer when a refund completes?

Assumed: No; the ledger update emits nothing; refund emails are a later ticket

Answer: Accepted (2026-11-22): booking emits nothing new; Notification notifies straight from payment.refunded (ticket 21).

## 2026-11-21 11:57 ticket 21

What happens to a refund event without a contact (unknown_order)?

Assumed: Acked and logged at info, no notification record; a retry could never supply a recipient

Answer: Accepted (2026-11-22): for unknown_order, ack and log with no notification record. Any other refund request without a contact fails validation (now enforced by the schema).

## 2026-11-21 11:57 ticket 21

What does 'duplicate delivery' cover in AT-43?

Assumed: A redelivery of the same message and a copy of the same event under a new message id; dedupe is by sourceEventId. A future reconciler re-emit of payment.refund_requested under a new event id would send a second refund-initiated notification (documented)

Answer: Accepted (2026-11-22): same-message redelivery and the same event under a new transport msgId. A reconciler re-emit under a new eventId needs an explicit notification-dedupe decision later; it is not automatically a new business notification.

## 2026-11-21 11:57 ticket 21

What do refund notifications contain and how are the consumers named?

Assumed: Templates refund-initiated and refund-completed only (email always, SMS with a phone); consumers notification-refund-requested and notification-refunded

Answer: Accepted (2026-11-22): refund-initiated and refund-completed; email always, SMS with a phone; consumers notification-refund-requested and notification-refunded.

## 2026-11-23 11:33 ticket 50

The last criterion asks to mark TD-053/062/065/072 RESOLVED in docs/technical-debt.md, but CLAUDE.md declares that register frozen (not updated by runs) and CI checks it for changes.

Assumed: Leave docs/technical-debt.md untouched; the commit message names each TD and the tests that prove it, so a human can close the entries

Answer: Accepted (2026-11-23): the register stays unchanged; a human closes the entries from the test evidence named in the commit.

## 2026-11-23 11:43 ticket 50

What does the Payment consumer do with order.placed redelivered under a new event id for an order that already has a payment attempt (TD-053)?

Assumed: Idempotent skip: acked, processed_messages row committed, no second attempt and no second payment.succeeded/failed (createMany skipDuplicates on orderId+attemptNo). An invalid order.placed payload stays a thrown parse error, nak'd on the ADR 0011 schedule

Answer: Accepted (2026-11-23): idempotent skip with a processed_messages row, no new payment attempt and no outcome event. An invalid payload still fails and is redelivered on the ADR 0011 schedule.

## 2026-11-23 12:34 ticket 54

Which metrics eventId key does booking_busy use when placeOrder fails before its event is known?

Assumed: eventId = "unknown" (Redis hash booking:metrics:unknown), documented in docs/database/index.md

Answer: Accepted (2026-11-23): eventId = "unknown"; documented, and it cannot collide with a UUID.

## 2026-11-23 12:34 ticket 54

What acquire timeout, maxWait, margin and jitter does booking use?

Assumed: acquireTimeoutMs = maxWait = 3s (room for a cold Neon start); margin 1s so the Prisma timeout is 3x3s+5s+1s = 15s; jitter 20 + floor(random*180) ms; worst case (retries+1)*(maxWait+timeout)+retries*200ms = 72.6s

Answer: Accepted (2026-11-23): 3 s / 3 s / 1 s / 20-199 ms. 72.6 s bounds the transaction attempts only; the reads before the transaction come on top of it.

## 2026-11-23 12:34 ticket 54

How is a statement_timeout 57014 told apart from a pg_cancel_backend 57014?

Assumed: By the driver's originalMessage, pinned in both real-Postgres tests

Answer: Accepted (2026-11-23): by originalMessage; the exact messages are pinned by real-Postgres tests.

## 2026-11-23 12:34 ticket 54

Should the 3s acquire timeout apply only to booking queries?

Assumed: It applies to the whole production web Prisma client (one pool); deadlock_retry is a new BookingMetric not shown on the admin dashboard

Answer: Accepted (2026-11-23): consistent for one shared pool; showing deadlock_retry on the dashboard is not a ticket requirement.

## 2026-11-23 12:42 ticket 55

TD-016 asks its Resolution in docs/technical-debt.md to state the flag mechanism and argument, but the register is frozen

Assumed: Register untouched; the mechanism and soundness argument go in a WHY comment at the clock-after-lock test and in the commit message

Answer: Accepted (2026-11-23): WHY comment and commit message; the register can be updated by hand later.

## 2026-11-23 13:51 ticket 55

TD-079 asks to compare database-clock commit timestamps; track_commit_timestamp is off and a refused hold writes no row

Assumed: Proved by the order of reads from the injected clock (reads.lastIndexOf(queuedFirst) < reads.lastIndexOf(other)) per test.each case

Answer: Accepted (2026-11-23): the buyer lock is held until the transaction ends, so the order of clock reads inside it is valid evidence. For a refused hold this is rollback order, not a commit timestamp.

## 2026-11-23 13:51 ticket 55

How does TD-006 run shuffled in the gate?

Assumed: Separate web-shuffled / db-shuffled Vitest projects for catalog.test.ts and seed.test.ts with root sequence.seed 3; admin-demo.test.ts is order-dependent when shuffled (pre-existing) and stays out of the shuffled project

Answer: Accepted (2026-11-23): separate catalog/seed projects with a fixed seed; leaving admin-demo out meets the criterion.

## 2026-11-23 13:51 ticket 55

seed.test.ts cannot import @ticketarena/booking/testing (booking depends on db)

Assumed: seed.test.ts opens and closes its own client per test and keeps its own NOW

Answer: Accepted (2026-11-23): it avoids reversing the booking -> db dependency.

## 2026-11-23 14:39 ticket 63

Which Redis timeouts and reconnect policy do the apps use?

Assumed: REDIS_CONNECT_TIMEOUT_MS 2000 and REDIS_COMMAND_TIMEOUT_MS 1000 (zod-validated, injected); no retry before the first connect (client destroyed and rebuilt on next use), backoff min(50*2^n, 2000) ms after; the lazy connection enforces its own command deadline because node-redis 6.3's timeout stops once a command is written

Answer: Accepted with a fix (2026-11-23): 2000/1000 ms are right, but every reconnect handshake must be bounded too (PR #16 review, HIGH 2). Fixed in bd8b47c: node-redis no longer reconnects by itself; the lazy connection replaces a client that is not ready and connects under REDIS_CONNECT_TIMEOUT_MS, so the backoff is gone.

## 2026-11-23 14:39 ticket 63

What counts as 'Redis unreachable' and what do queue procedures answer?

Assumed: Any node-redis failure that is not an ErrorReply becomes RedisUnavailableError (fail open on revocation only); an error reply still fails admittedProcedure. Queue procedures answer SERVICE_UNAVAILABLE 'The waiting room is unavailable right now; try again shortly'

Answer: Overridden (2026-11-23): a server error reply fails closed even during the handshake (PR #16 review, HIGH 1); fixed in bd8b47c, so a WRONGPASS is rethrown as is, never RedisUnavailableError. SERVICE_UNAVAILABLE for the queue procedures is accepted.

## 2026-11-23 14:39 ticket 63

How does the worker /health report Redis?

Assumed: HTTP 200 {status:'ok', redis:'ok'|'unavailable'} from a bounded PING; the Upstash queue adapter is unchanged (neither app uses it), so choosing Upstash would fail closed on an outage

Answer: Accepted (2026-11-23): HTTP 200 with a separate Redis state from a bounded PING; the Upstash queue adapter's limit is documented.

## 2026-11-24 18:51 ticket 64

Which holds does the demo reset keep, and what does ordersKept count?

Assumed: Any hold that has an order (any status) is kept unchanged and no seat points to it any more; ordersKept counts every demo order of any status left after the reset

Answer: Accepted (2026-11-24): every hold with an order of any status stays unchanged, and after the reset no seat points to it; ordersKept counts every demo order kept.

## 2026-11-24 18:51 ticket 64

Should the unknown_order refund path stay now that the reset no longer causes it?

Assumed: Yes, unchanged as a safety net; only its comments and docs were updated

Answer: Accepted (2026-11-24): it stays as a safety net; a real capture for an unknown order must never be dropped, even if the reset no longer causes one.

## 2026-11-24 18:59 ticket 65

How does a refused or unavailable admin login answer in the form-POST flow?

Assumed: 303 to /admin/login?error=rate-limited&retry=<ceil seconds, min 1> plus Retry-After; an unreachable or misconfigured limiter answers 303 ?error=unavailable and logs the error (fails closed, no 500 page)

Answer: Accepted (2026-11-24): 303 after the form POST; when rate-limited, a retry rounded up to at least 1 s plus Retry-After; an unreachable or failing limiter answers unavailable and is logged on the server. No cookie is set.

## 2026-11-24 18:59 ticket 65

Does every login attempt use up the limiter window, and does logout need a valid admin cookie?

Assumed: Every attempt, right or wrong, takes the window; parseAdminEnv still runs first; logout needs no cookie and clears ta_admin with the same attributes

Answer: Accepted (2026-11-24): right and wrong passwords both use up the login window; invalid app configuration may stop earlier; logout needs no valid cookie and clears it with the same attributes.

## 2026-11-24 19:02 ticket 38

What does 'deployed on Fly.io / Vercel' mean for an unattended run with no credentials?

Assumed: Everything needed to deploy is committed and verified locally (Dockerfile, fly.toml for worker and NATS, nats.conf, deploy workflow, env validation); the run deploys nothing and calls no real service; the one-time human steps (apps, volume, secrets, Vercel link, GitHub secrets) are a step-by-step runbook in docs

Answer: Accepted as preparation (2026-11-24): Docker/Fly/Vercel/workflow and the one-time human steps are reviewable; no account creation or real deployment is faked. The hosted/live-demo criterion is not proven by this.

## 2026-11-24 19:21 ticket 38

The docs must link the recovery runbook, but it belongs to ticket 27, which is still open. What do they link to?

Assumed: ADR 0011, the spec section 'Consumer recovery (runbook and script)' and issues/27, saying plainly the runbook is not built yet; no runbook invented here

Answer: Partly accepted (2026-11-24): linking ADR 0011, the spec and ticket 27, and saying plainly the runbook is missing, is right, but it does not meet the runbook criterion. Either build the dependency or amend/defer the criterion explicitly.

## 2026-11-24 19:21 ticket 38

When does the deploy workflow run, and what if secrets are missing?

Assumed: New deploy.yml (ci.yml untouched): workflow_run after CI succeeds on main, or workflow_dispatch; migrate (direct URL) then web (Vercel CLI, git deploys off) and worker; a gate job skips each target whose secrets are missing; NATS deployed by hand; Fly apps ticketarena-nats/ticketarena-worker in fra, single machine, NATS unauthenticated on the private network only

Answer: Accepted with a fix (2026-11-24): deploying after green main CI, skipping clearly on missing secrets, and NATS by hand are right. A manual run must also require green CI of the exact commit, and redeploying an old commit is excluded (fixed in 72fad6f). A partial job re-run reuses the old gate output, so each production job re-checks its pinned commit right before acting (re-review of e22945c). NATS without auth stays only with an explicitly accepted, trusted Fly-org boundary.

## 2026-11-24 19:21 ticket 38

ADR 0013 says Upstash REST in web and worker; the queue and saga counters use node-redis over rediss://. Switch now?

Assumed: No: keep node-redis over Upstash TLS (switching needs the REST queue's errors mapped to SERVICE_UNAVAILABLE); documented in docs/operations/deployment.md; a human decides on an ADR amendment or ticket

Answer: ADR decision needed (2026-11-24): no forced adapter switch without evidence, but the deviation must be accepted by a reviewed ADR amendment, or the REST wiring finished. A follow-up in the docs is not enough. Resolved (2026-11-26): the maintainer accepted ADR 0025.

## 2026-11-24 19:30 ticket 66

Is SENT recorded per channel right after each send, or all together?

Assumed: All together in the runner's transaction with the dedupe row; beforeTransaction creates/reuses PENDING per channel and sends outside any transaction, keyed by notification id; no schema change (PENDING already existed)

Answer: Accepted (2026-11-24): PENDING rows durably first, sends outside the transaction, then SENT for every channel that succeeded plus the dedupe row atomically in the runner's transaction. A partial failure is resent with the same notification-id keys.

## 2026-11-24 19:30 ticket 66

How is 'a crash after the send' simulated?

Assumed: The test wraps the runner's Prisma client so its first $transaction fails (database-boundary failure) instead of killing the process

Answer: Accepted as a simulation of the crash window (2026-11-24): the first runner transaction after the sends fails, leaving the right PENDING state, and real NATS redelivery follows. It is not a process-kill/restart test and must not be called one.

## 2026-11-24 19:45 ticket 67

Which errors carry a domainCode, and is the stack ever sent?

Assumed: The 11 booking errors the booking router maps plus admin RESET_BLOCKED and NOT_DEMO_EVENT; queue SERVICE_UNAVAILABLE (Redis outage) and unmapped domain errors (INTERNAL_SERVER_ERROR) carry none; data is built field by field (code, httpStatus, path, domain fields) and never includes a stack in any environment

Answer: Accepted (2026-11-24): an explicit whitelist of 11 booking and 2 admin errors; any other error has no domainCode; no stack in data in any environment. The raw internal message was a separate hardening point, fixed in 425c1e0.

## 2026-11-24 19:45 ticket 67

Is data.seatIds required by the type when domainCode is SEAT_UNAVAILABLE?

Assumed: No: both optional on one object type; the UI falls back to [] so domainCode stays readable without narrowing a union

Answer: Accepted (2026-11-24): the optional fields with the empty-array UI fallback meet the ticket. A discriminated union would give a stronger static guarantee but is not needed for this scope.

## 2026-11-26 12:06 ticket 68

What is 'the current session' for activeHold?

Assumed: Both sessionId and buyerKey must match, so another session of the same signed-in user never gets the hold (stricter than getHold, which matches buyerKey only)

Answer: Accepted (2026-11-26): sessionId and buyerKey must both match; another session of the same user does not get the hold back.

## 2026-11-26 12:06 ticket 68

Several live holds for one event: which does activeHold return, and is it admission-gated?

Assumed: The one with the latest holdExpiresAt; public (not admission-gated) since a hold outlives the 30-minute admission; shape is holdSeats output plus seats [{id, priceMinor, currency}]

Answer: Accepted (2026-11-26): the live hold with the latest holdExpiresAt, an owner-filtered public endpoint without admission; the hold data plus priced seats is the right output.

## 2026-11-26 12:06 ticket 68

When does the UI read activeHold?

Assumed: Once on mount, no refetch on focus; ending a hold on the page sets the cached result to null; a restored hold already past holdExpiresAt ends at once with the usual expiry alert

Answer: Fixed (2026-11-26, PR #18 review): every real mount reads activeHold fresh (refetchOnMount always), so a cached null or an ended hold from an earlier visit is never served; focus refetch stays off. Ending a hold cancels a restore read still in flight before writing null, so its late answer cannot bring the hold back. A restored hold is shown only once this mount's own read has answered, so a hold cached from an earlier visit cannot expire on screen and cancel the read that brings a newer live hold (second PR #18 review). Ending an already expired restored hold at once is accepted.

## 2026-11-26 12:17 ticket 69

Batch size and pass budget for the reaper?

Assumed: REAP_BUDGET { batchSize: 100, maxBatches: 50 } (up to 5,000 slots per event per 15 s pass), exported and overridable via QueueServiceDeps.reapBudget; no new env variables

Answer: Accepted (2026-11-26): batchSize 100, maxBatches 50, injectable override, no new env. At most 5,000 examined candidates per event per pass; some candidates only drop orphan jtis rather than free a slot.

## 2026-11-26 12:17 ticket 69

How does the reaper find the slot of an expired admission without scanning active?

Assumed: New per-event hash waiting-room:{eventId}:holders (jti -> session id), kept in sync by every script that writes or removes an admission; idle candidates are examined first, expired admissions take the rest of the batch

Answer: Accepted (2026-11-26): the jti -> session hash, kept atomically by the scripts that change an admission; idle candidates first, then expired ones from the rest of the batch.

## 2026-11-26 12:17 ticket 69

Slots that predate the holders hash, or fresh slots missing a jti?

Assumed: Not migrated: an expired pre-deploy jti is dropped and its slot is freed once 90 s idle or on re-join (gap closes within 30 min of deploy); a fresh slot with no jti is no longer freed immediately, only when idle (no script creates one)

Answer: Changed (2026-11-26, PR #18 review): the 30-minute claim was not guaranteed, since status polls kept heartbeating an old-layout slot. The heartbeat now refreshes a slot only while its admission is valid, so such a slot goes idle and is reaped at most 90 s plus one reaper interval after its admission expired, with no backfill; a contract test starts from the old key layout on both adapters. A slot with no jti at all (state no script produces) is likewise never refreshed and is reaped as idle.

## 2026-11-26 17:14 ticket 26

The last AC asks to mark TD-036 RESOLVED in docs/technical-debt.md, but CLAUDE.md says that register is frozen and not updated by runs. Which wins?

Assumed: CLAUDE.md wins, as for ticket 14: the register is not edited; the TD-036 tests are named in the commit message and a human updates TD-036 if wanted

Answer: (open)

## 2026-11-26 17:29 ticket 43

The last AC asks to mark TD-001, TD-003, TD-010, TD-011 and TD-028 RESOLVED in docs/technical-debt.md, but CLAUDE.md freezes that register. Which wins?

Assumed: CLAUDE.md wins, as for tickets 14 and 26: the register is not edited; the verifying tests are named in the commit message and a human updates the entries

Answer: (open)

## 2026-11-26 19:36 ticket 43

Fix TD-028 by editing the unique venues.name migration or by adding a new one?

Assumed: A new migration 20261030025000_merge_duplicate_venues runs just before the unique index; the applied migration is untouched (no checksum change); lowest-id venue survives, same-name sections and same-label rows merge into the survivor's, no seat is deleted

Answer: (open)

## 2026-11-26 19:36 ticket 43

Where does the seed command live once packages/db stops reading process.env?

Assumed: apps/worker (pnpm --filter @ticketarena/worker db:seed), validated by parseSeedEnv; the URL is not a CLI argument so the secret stays out of the process list

Answer: (open)

## 2026-11-26 19:36 ticket 43

How is the database made lazy for procedures that do not use it?

Assumed: ctx.db becomes a function () => PrismaClient (not a getter, since tests spread the context); the env scan skips packages/test-infra and the generated Prisma client

Answer: (open)

## 2026-11-26 19:38 ticket 45

The last AC asks to mark TD-031 and TD-032 RESOLVED in docs/technical-debt.md, but CLAUDE.md freezes that register. Which wins?

Assumed: CLAUDE.md wins, as for tickets 14, 26 and 43: the register is not edited; the verifying tests are named in the commit message and a human updates the entries

Answer: (open)

## 2026-11-26 19:44 ticket 45

How are repeated identical relay/consumer failures rate-limited?

Assumed: First failure and any new cause (error name+message) log at error; the same cause logs at most once per 60 s (FAILURE_LOG_WINDOW_MS) with failures/suppressed counts; recovery logs one info line with failures and outageMs; shared by relay and consumer runner

Answer: (open)

## 2026-11-26 19:53 ticket 24

What delay applies past the 4th delivery?

Assumed: 2m repeats for every later delivery; ending retries is ticket 25's DLQ gate (deliveryCount > 5), which goes before the handler and leaves RETRY_DELAYS_MS alone

Answer: (open)

## 2026-11-26 19:55 ticket 46

The last AC asks to mark TD-034 and TD-035 RESOLVED in docs/technical-debt.md, but CLAUDE.md freezes that register. Which wins?

Assumed: CLAUDE.md wins, as for tickets 14, 26, 43 and 45: the register is not edited; the verifying tests are named in the commit message and a human updates the entries

Answer: (open)

## 2026-11-26 20:07 ticket 46

What is the worker's shutdown deadline and how is it configured?

Assumed: DEFAULT_SHUTDOWN_DEADLINE_MS = 25000 in apps/worker/src/lifecycle.ts (under Fly's 30 s kill_timeout), overridable via a deadlineMs option, no env variable; one deadline for the whole ordered shutdown; a relay tick cut off at the deadline rolls back and its rows stay PENDING

Answer: (open)

## 2026-11-26 20:09 ticket 51

The last AC asks to mark TD-048 RESOLVED in docs/technical-debt.md, but CLAUDE.md freezes that register. Which wins?

Assumed: CLAUDE.md wins, as for tickets 14, 26, 43, 45 and 46: the register is not edited; the verifying tests are named in the commit message and a human updates the entry

Answer: (open)

## 2026-11-26 20:18 ticket 51

Redact buyer contact details by key, by value pattern, or both?

Assumed: Both, in one shared redactLogLine in packages/contracts applied via pino streamWrite: keys matching /e-?mail|phone|recipient/i become [Redacted] at any depth, and emails or 7+ digit phone-like runs inside any string are redacted; over-redaction of bare long numbers is accepted

Answer: (open)

## 2026-11-26 20:20 ticket 57

The last AC asks to mark TD-070 RESOLVED in docs/technical-debt.md, but CLAUDE.md freezes that register. Which wins?

Assumed: CLAUDE.md wins, as for the earlier tickets of this run: the register is not edited; the verifying tests are named in the commit message and a human updates the entry

Answer: (open)

## 2026-11-26 20:31 ticket 57

What do holdSeats and placeOrder do when Upstash is missing or misconfigured?

Assumed: Book uncounted (optionalMetrics, as admin.runRace does); the lazy metrics dependency logs the configuration error once at the boundary, not per request

Answer: (open)

## 2026-11-27 07:03 ticket 70

Shape of the orphan refund obligation, and are existing unknown_order outbox rows backfilled?

Assumed: Table public.orphan_refund_obligations keyed by paymentId (orderId without FK, amount, currency, capturedAt, status REFUND_REQUESTED|REFUNDED, refundRequestedAt); the PK insert replaces the advisory lock; existing unknown_order outbox rows are backfilled as open obligations from the earliest request, capturedAt = occurredAt; MANUAL_REVIEW and attempts are left to ticket 23

Answer: (open)
