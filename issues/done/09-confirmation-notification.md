# 09: Confirmation notification

**What to build:** a confirmed order produces exactly one confirmation email record (and one SMS record when a phone number was given) through the mock Notification service, completing the happy path end to end. Spec: Mock Notification service.

**Blocked by:** 08

**Status:** done

**Completed:** 2026-11-05 by slice/09-confirmation-notification (run 20261105-075349)

- [x] `notification` schema with `notifications` (`sourceEventId`, `channel`, recipient, template, `status` `PENDING | SENT`; unique `(sourceEventId, channel)`) and its own `processed_messages`.
- [x] The Notification module consumes `order.confirmed`: inserts `PENDING`, calls the mock provider with `idempotencyKey = notification id`, marks `SENT`.
- [x] The mock provider records deliveries and dedupes by key.
- [x] AT-15: hold → order → payment succeeded → `CONFIRMED`, `APPLIED`, seats `SOLD`, one confirmation record.
- [x] AT-14 (second half): with `+dup@`, exactly one notification record per channel.
- [x] External delivery is documented as at-least-once.
