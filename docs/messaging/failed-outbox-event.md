# Runbook: a FAILED outbox event

[← Async messaging](index.md)

An outbox row whose publish failed permanently as many times as the relay's cap (default 5) is
`FAILED` ([ADR 0022](../adr/0022-terminal-failed-outbox-events.md)). It is not delivered until you
act; later events of its aggregate are delivered without it. Nothing is lost: the row, its payload
and its history stay where the business transaction wrote them.

## 1. The alert

- **Log line**, once per row, at `error`, from the worker's `outbox-relay` component:
  `outbox event FAILED: permanent publish failures reached the cap`, with `service`
  (`booking`, `payment` or `notification`), `outboxId`, `aggregateType`, `aggregateId`, `eventType`,
  `attempts` and `lastError`. The payload is never logged.
- **Health flag**: the worker's `GET /health` has `outbox.alert: true` while any row is `FAILED`, and
  per service `failed` (rows now `FAILED`), `oldestFailedAgeMs` (how long the oldest has waited) and
  `failedTransitions` (every transition to `FAILED` ever recorded). The worker stays live (`status: ok`).

## 2. Find and inspect the row

The outbox table is `outbox_events` in the service's schema (`public` for booking, `payment`,
`notification`):

```sql
SELECT "id", "aggregateType", "aggregateId", "eventType", "attempts", "permanentFailures",
       "lastError", "createdAt", "failedAt", "payload"
FROM "payment"."outbox_events" WHERE "status" = 'FAILED' ORDER BY "failedAt";

SELECT "kind", "fromStatus", "toStatus", "attempt", "error", "operator", "reason", "at"
FROM "payment"."outbox_event_history" WHERE "outboxId" = '<outbox id>' ORDER BY "id";
```

(`readOutboxHistory(prisma, service, outboxId)` in `@ticketarena/messaging` returns the same.) The
history shows every permanent failure and every status change, including earlier requeues.

## 3. Decide

`lastError` names the cause:

- `no stream matches subject ta.<eventType>`: no stream captures the event type. Usually a stream
  declared or updated without that subject, or an event type added in code without its subject in
  the topology (`jetstream-message-bus.ts`, ADR 0004). Fix the topology (deploy the fix; the
  worker's start re-applies it, updating the stream in place), then requeue.
- `payload exceeds the broker's max_payload`: the envelope is larger than NATS accepts. Raising the
  server's `max_payload` (infra/fly/nats) is the fix that keeps the event as written; then requeue.
- `payload cannot be serialised`: a code bug; fix the producer for new events.

If the event must not be delivered (the fix is impossible, or delivering it now would be wrong),
**leave it `FAILED`** and record why in your incident notes; the alert stays raised as the standing
record that it was not delivered.

Before requeueing an event whose later events were already delivered, check ADR 0022's table: every
current consumer either applies the earlier event correctly when it arrives late or refuses it
without a change, so a requeue converges to the in-order end state.

## 4. Requeue

From the repository root, with `DATABASE_URL` set to the database (the direct URL):

```bash
pnpm --filter @ticketarena/worker outbox:requeue \
  --service payment --id <outbox id> --operator <your name> --reason "<what you fixed>"
```

It moves exactly that row from `FAILED` to `PENDING`, resets its `permanentFailures` to 0, clears
`failedAt` and appends a `FAILED` -> `PENDING` history entry with your name and reason. It refuses
(exit 1, nothing changed) a row that is not `FAILED` (`... is PUBLISHED, not FAILED`) or an id that
does not exist. If the cause is not fixed, the row fails again and returns to `FAILED` after the cap.

## 5. Confirm it was published and consumed once

- The row is `PUBLISHED` with `publishedAt` set (`SELECT "status", "publishedAt" ...`).
- Each consumer of the event type ([event catalogue](index.md#event-catalogue)) has one
  `processed_messages` row with `messageId = <outbox id>` in its service's schema. A redelivery is
  absorbed there, so the count stays at one.
- `/health` shows `failed` back to 0 for the service (or the remaining ones), and the alert clears
  when none is left.

## Never

- **Never delete the row**: the event and its history would be lost.
- **Never set it `PUBLISHED` by hand**: nothing would deliver it, and it would look delivered.
- **Never re-insert it under a new id**: consumers deduplicate on the outbox id (`Nats-Msg-Id`), so a
  new id could apply the event twice. Requeueing keeps the original id.
