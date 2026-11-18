# 61: No admission before the queue opens

**What to build:** a buyer cannot get ahead of the randomized pre-queue by arriving early. Today `join` treats "before `queueOpensAt`" the same as "after `queueClosesAt`" and admits at once, so a buyer who joins just before the queue opens holds an admission that can still be valid at `onSaleAt` and never queues. Before the queue opens, `join` now says the queue is not open yet and admits no one; after it closes, `join` still admits immediately. As defence in depth, seats cannot be held before the event's `onSaleAt`. Follows the answer recorded for ticket 28 in `.devflow/questions.md`; ADR 0008. Update the Waiting room section of the MVP spec and the waiting-room docs to match.

**Blocked by:** 28

**Status:** ready-for-agent

- [ ] `join` before `queueOpensAt` answers `NOT_OPEN` with the time the queue opens, adds nothing to the queue and admits no one; `AdmissionPolicy` exposes the three phases (not open, active, closed) instead of one boolean.
- [ ] `join` at exactly `queueOpensAt` queues the buyer in the pre-queue; `join` at or after `queueClosesAt` still answers `ADMISSIBLE`.
- [ ] `queue.join` returns the `NOT_OPEN` result to the client (not an error), so the page can show when the queue opens.
- [ ] `holdSeats` before the event's `onSaleAt` fails with a named domain error and changes nothing; one millisecond after `onSaleAt` it succeeds as before. The tRPC mapping is documented with the other hold errors.
- [ ] The admission ticker admits no one before `onSaleAt` (already fixed in PR #9 with a regression test in `queue-service.test.ts` and `apps/worker/src/admission.test.ts`); keep both tests green and state the invariant in the spec.
- [ ] The spec's Waiting room section says the queue admits immediately only after it closes, and before it opens `join` answers `NOT_OPEN`.
