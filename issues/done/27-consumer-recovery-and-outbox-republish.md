# 27: Consumer recovery and outbox re-publish

**What to build:** an operator can recreate a consumer, or recover from broker data loss, without ever skipping an unprocessed message, using a script and a documented runbook. Spec: Consumer recovery; ADR 0011.

**Blocked by:** 25, 44 (payment latency outside the runner transaction), 49 (Prisma schema drift), 59 (terminal outbox failures), 70 (durable orphan refund obligation, before any outbox retention)

**Status:** done

**Completed:** 2026-11-27 on devflow/run-202611271130 (run 202611271130)

**Status reason:** retry, DLQ and recovery after the MVP (2026-11-18)

- [x] The recreation script applies the rules in order:
  1. Ack floor available → `by_start_sequence` at `ack_floor + 1`.
  2. Otherwise, if a reliable contiguous checkpoint exists → scan the retained stream with the consumer's filter against `processed_messages` and resume at the first unprocessed sequence.
  3. Otherwise → replay from the earliest retained message.

  It never derives a start point from a timestamp or from "highest processed minus a margin".
- [x] An outbox re-publish script moves rows in a time range back to `PENDING`.
- [x] A retention job deletes outbox rows and `processed_messages` older than 14 days.
- [x] Payment skips an `order.placed` whose `paymentDeadline` has passed at processing time (ack and log).
- [x] AT-32: recreating after out-of-order partial processing with an ack floor → every unprocessed message is delivered, none skipped.
- [x] AT-33: processed {1, 2, 3, 5}, consumer deleted → resume at 4; 5 is redelivered and deduped.
- [x] AT-34: no checkpoint → replay from the earliest retained message with no duplicate side effects.
- [x] The runbook in `docs/messaging` documents every rule and the 14-day recovery limit.
- [x] `docs/operations/deployment.md` (Recovery) links the runbook and no longer says it is not built; deferred here from ticket 38 (PR #17 review, 2026-11-24).
- [x] ~~Every entry in `docs/technical-debt.md` whose Target is ticket 27 (TD-033) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).~~ Superseded by [ADR 0024](../../docs/adr/0024-frozen-debt-register-check.md): `docs/technical-debt.md` is frozen and never edited; the evidence is recorded below instead.

## Evidence (ADR 0024: TD-033)

TD-033 (retention is documented but no job exists; `processed_messages` grows without bound and a reader assumes cleanup exists): the worker now runs `pruneRetention` hourly, deleting `processed_messages` rows older than 14 days in every service schema, and outbox rows `PUBLISHED` more than 14 days ago. The schema comment on `ProcessedMessage` names the job, and `docs/database/index.md` has a Retention section.

- `packages/messaging/src/outbox-retention.test.ts` :: "deletes every service's processed_messages rows older than 14 days and keeps newer ones"
- `packages/messaging/src/outbox-retention.test.ts` :: "deletes every service's PUBLISHED outbox rows published more than 14 days ago and keeps the rest"
- `packages/messaging/src/outbox-retention.test.ts` :: "never deletes a FAILED row, however old, nor a row with history, and keeps their history (ADR 0022)"
- `packages/messaging/src/outbox-retention.test.ts` :: "keeps an unknown_order refund request until its orphan refund obligation exists (refund cutover)"
- `apps/worker/src/worker.test.ts` :: "deletes PUBLISHED outbox rows and processed_messages older than 14 days, at start and then every hour"

## Tests per criterion

- Recreation rules in order: `packages/messaging/src/consumer-recovery.test.ts` (AT-32, AT-33, AT-34 below; also "resumes at the dead-lettered message when the ack floor is ignored, so the fixed consumer applies it" and "does not use an ack floor recorded under another filter subject"); the script: `apps/worker/src/consumer-recover.test.ts` :: "recreates a worker consumer by name at the first message its service has not processed".
- Outbox re-publish: `packages/messaging/src/outbox-republish.test.ts` :: "moves the PUBLISHED rows published in [from, to) back to PENDING and records each in the history", "never touches a FAILED or a PENDING row, so a FAILED row leaves only by the audited requeue", "after broker data loss, re-publishes under the original id and a consumer that processed it dedupes it"; the script: `apps/worker/src/outbox-republish-main.test.ts` :: "moves the service's PUBLISHED rows in the range to PENDING with the operator and reason, and exits zero".
- Retention job: see the evidence above.
- Payment deadline skip: `apps/worker/src/payment/payment-handler.test.ts` :: "skips an order.placed whose paymentDeadline has passed at processing time: acked and logged, no attempt and no result".
- AT-32: `packages/messaging/src/consumer-recovery.test.ts` :: "AT-32: with an ack floor after out-of-order processing, resumes at ack_floor + 1 and delivers every unprocessed message".
- AT-33: `packages/messaging/src/consumer-recovery.test.ts` :: "AT-33: processed {1, 2, 3, 5} and the consumer deleted, resumes at 4; 5 is redelivered and deduped".
- AT-34: `packages/messaging/src/consumer-recovery.test.ts` :: "AT-34: with no reliable checkpoint, replays from the earliest retained message with no duplicate side effects".
- Runbook: [docs/messaging/consumer-recovery.md](../../docs/messaging/consumer-recovery.md) (reviewed, not test-verified), linked from `docs/messaging/index.md`, `docs/messaging/failed-outbox-event.md` and `docs/operations/deployment.md` (Recovery).
