# 27: Consumer recovery and outbox re-publish

**What to build:** an operator can recreate a consumer, or recover from broker data loss, without ever skipping an unprocessed message, using a script and a documented runbook. Spec: Consumer recovery; ADR 0011.

**Blocked by:** 25

**Status:** ready-for-agent

- [ ] The recreation script applies the rules in order:
  1. Ack floor available → `by_start_sequence` at `ack_floor + 1`.
  2. Otherwise, if a reliable contiguous checkpoint exists → scan the retained stream with the consumer's filter against `processed_messages` and resume at the first unprocessed sequence.
  3. Otherwise → replay from the earliest retained message.

  It never derives a start point from a timestamp or from "highest processed minus a margin".
- [ ] An outbox re-publish script moves rows in a time range back to `PENDING`.
- [ ] A retention job deletes outbox rows and `processed_messages` older than 14 days.
- [ ] Payment skips an `order.placed` whose `paymentDeadline` has passed at processing time (ack and log).
- [ ] AT-32: recreating after out-of-order partial processing with an ack floor → every unprocessed message is delivered, none skipped.
- [ ] AT-33: processed {1, 2, 3, 5}, consumer deleted → resume at 4; 5 is redelivered and deduped.
- [ ] AT-34: no checkpoint → replay from the earliest retained message with no duplicate side effects.
- [ ] The runbook in `docs/messaging` documents every rule and the 14-day recovery limit.
