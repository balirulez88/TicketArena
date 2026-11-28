# Runbook: consumer recovery and outbox re-publish

[← Async messaging](index.md)

Use this runbook to recreate a durable consumer, to replay a dead-lettered message after its cause
is fixed, or to recover from broker data loss. The rules come from
[ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md). The guiding principle: **replaying a processed
message is fine, skipping an unprocessed one is not.** Every consumer deduplicates on its
`processed_messages` row (the envelope id, `Nats-Msg-Id`), so these tools over-replay on purpose.

## 0. Prefer an in-place update

Do not recreate a consumer just to change its settings. The worker's start applies `ensureTopology()`
and converges each durable it subscribes (`AckWait`, `MaxDeliver`, filter subject) in place, without
moving its position. Recreate only when the durable is gone (deleted, or lost with the broker's data),
or when you must move its start, for example to replay a dead-lettered message.

## 1. Stop the consumer

Stop the worker first, so no consumer is running while its durable is recreated:
`fly scale count 0 --app ticketarena-worker`. Bring it back after step 2 with `fly scale count 1`.
The worker's start finds the recreated durable and keeps its start position.

## 2. Recreate the consumer

From the repository root, with `DATABASE_URL` (the direct URL), `NATS_URL` and, for the Fly NATS,
`NATS_TOKEN` set:

```bash
pnpm --filter @ticketarena/worker consumer:recover --consumer <durable name> [--ignore-ack-floor]
```

The consumer is one of the worker's durables (`payment`, `payment-refund`, `booking-saga`,
`booking-saga-failed`, `booking-saga-refunded`, `notification`, `notification-cancelled`,
`notification-expired`, `notification-refund-requested`, `notification-refunded`). The script uses that
consumer's own filter subject and its own service's `processed_messages`. An unknown name is refused,
and the error lists the valid ones. The script deletes the durable if it exists and creates it again
with the worker's settings. It prints the rule it used and the first stream sequence the consumer
will deliver. It tries the rules in this order:

1. **Ack floor.** The durable exists with the same filter: delivery starts at
   `ack_floor.stream_seq + 1`. Every message at or below the floor is settled. Messages above it may
   have been processed out of order and are delivered again, then deduplicated (AT-32).
2. **Checkpoint scan.** There is no ack floor (the durable is gone, or you passed
   `--ignore-ack-floor`), but `processed_messages` is a reliable checkpoint. The script scans the
   retained stream from its first message with the consumer's filter, checks each envelope id
   against the consumer's `processed_messages`, and starts at the **first message without a row**.
   Later processed messages are delivered again and deduplicated (AT-33: with {1, 2, 3, 5} processed
   it starts at 4, and 5 comes again as a duplicate). If every retained message has a row, it starts
   after the stream's last message. The scan counts as finished only when it reaches the stream's
   last message, or when the stream confirms that no matching message is left. If a pull comes back
   empty while matching messages remain (a slow link, a reader reset), the script fails with an
   error naming the consumer and the last sequence it reached. It has changed nothing at that
   point, so rerun it. The checkpoint is reliable when the stream's first retained
   message is newer than the 14-day `processed_messages` retention, so no row for a retained
   message can have been deleted yet. With the stream's 7-day `max_age` that is always true unless
   the stream was reconfigured.
3. **Earliest.** No reliable checkpoint: delivery starts at the earliest retained message, and
   everything already processed is deduplicated (AT-34).

The script **never** derives a start from a timestamp or from "the highest processed sequence minus a
margin". Messages are processed out of order, so a message below the highest processed one can still
be unprocessed. The current time only decides whether rule 2 may be used.

### Replaying a dead-lettered message

A dead-lettered message ([DLQ](index.md#worker-relay-and-consumer-runner), copy on
`ta.dlq.<consumer>`) is terminated. JetStream counts a terminated message as settled, so the ack
floor has already moved past it and rule 1 would never deliver it again. Once the cause is fixed and
deployed:

1. Read the copy from `TICKETARENA_DLQ` (`nats stream get TICKETARENA_DLQ <seq>`): the
   `TA-DLQ-Stream-Seq`, `TA-DLQ-Cause` and `TA-DLQ-Reason` headers, and the original envelope as the
   body (a copy with `TA-DLQ-Part` headers is split: join the parts' bodies in order, or use
   `readDeadLetters`). Check in [ADR 0022's table](../adr/0022-terminal-failed-outbox-events.md)
   that applying it now converges.
2. Stop the worker, then run `consumer:recover --consumer <name> --ignore-ack-floor`. Rule 2 starts at
   the first message without a `processed_messages` row, which is the dead-lettered one or an earlier
   unprocessed one.
3. Start the worker. A message that is still poison is dead-lettered again. Inside the DLQ's
   10-minute duplicate window the broker stores no second copy.

This is the "operator's replay" that ADR 0022's table and the
[FAILED outbox runbook](failed-outbox-event.md) refer to.

## 3. Beyond the stream: re-publish from the outbox

Use the outbox when the messages are no longer in the stream: the NATS volume was lost (single-node
disk loss), or a consumer is further behind than the 7-day `max_age`.

```bash
pnpm --filter @ticketarena/worker outbox:republish \
  --service <booking|payment|notification> --from <ISO time> --to <ISO time> \
  --operator <your name> --reason "<what happened>"
```

The range is on `publishedAt`, the time the message entered the stream (`from` inclusive, `to`
exclusive). Choose it to cover the lost window, for example from the last good volume snapshot until
now. `--from` must lie in the **replay window**: no earlier than 14 days before now. Only inside it
does every consumer still hold the `processed_messages` rows that deduplicate a re-published event.
An earlier `--from` is refused (exit 1, nothing changed), and the error names the window's start to
pass instead. This holds even for a row that is still in the outbox because it has history: that row
is kept for its audit, not for replay. Run it once per service whose outbox published in the window. The relays then publish the rows
again in their per-aggregate order, **under their original ids**. A consumer that already processed an
event deduplicates it, and one that never saw it applies it. For each row the script:

- moves only `PUBLISHED` rows to `PENDING`. A `PENDING` row is already on its way. A `FAILED` row is
  never touched: it goes back only through the audited requeue ([runbook](failed-outbox-event.md));
- clears `publishedAt` and resets `permanentFailures` to 0, as a requeue does, and keeps `attempts`,
  `lastError` and the payload;
- appends a `PUBLISHED` -> `PENDING` entry with your name and reason to `outbox_event_history`, in
  the same transaction.

An empty range, a range starting before the replay window, a missing operator or a missing reason is
refused (exit 1, nothing changed). The script prints the number of rows it moved. It is safe to run
while the worker's retention job runs: a row the job had selected but that the script moved to
`PENDING` first is kept, with its new history entry.

After broker data loss the stream's durables are gone with it, and the recreation script has no
stream to read. Start the worker: `ensureTopology()` declares the empty stream again, and each
consumer's subscribe creates its durable from the stream's first message (rule 3 on an empty
stream). Then run `outbox:republish`, so the re-published messages reach every consumer.

## The 14-day limit

The worker's retention job (hourly) deletes outbox rows that were `PUBLISHED` more than **14 days**
ago, and `processed_messages` rows older than 14 days. Both are kept longer than the stream's 7 days,
so recovery can always reach past the stream. **Events published more than 14 days ago cannot be
recovered automatically**, and `outbox:republish` refuses a `--from` before that. Their outbox rows
are gone, or kept only for their audit, and replaying them would no longer be deduplicated by
`processed_messages`. The retention job never deletes a `PENDING` row, a `FAILED`
row, a row with `outbox_event_history` (so a re-published row keeps its audit), or an
`unknown_order` refund request whose orphan refund obligation does not exist yet.

A replay can deliver old `order.placed` events. Payment skips any whose `paymentDeadline` has passed
at processing time: it acks and logs `order.placed skipped: its payment deadline has passed`, and
captures nothing. That order is expired by the sweeper as usual.

## Confirm

- The script printed the rule and start you expected.
- The consumer catches up: `nats consumer info TICKETARENA <name>` shows `num_pending` falling to 0.
- Each replayed event has exactly one `processed_messages` row per consumer (`messageId = <envelope id>`),
  and the worker logs `duplicate message skipped` for the deduplicated ones.

## Never

- **Never pick a start time or sequence by hand** (`nats consumer add --deliver <time>`). An arbitrary
  start can skip unprocessed messages. Use the script.
- **Never delete `processed_messages` rows by hand**: a replay would apply those events twice.
- **Never re-insert an outbox row under a new id**: consumers deduplicate on the original id.
