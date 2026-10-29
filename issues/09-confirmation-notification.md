# 09: Confirmation notification

**What to build:** a confirmed order produces exactly one confirmation email record (and one SMS record when a phone number was given) through the mock Notification service, completing the happy path end to end. Spec: Mock Notification service.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] `notification` schema with `notifications` (`sourceEventId`, `channel`, recipient, template, `status` `PENDING | SENT`; unique `(sourceEventId, channel)`) and its own `processed_messages`.
- [ ] The Notification module consumes `order.confirmed`: inserts `PENDING`, calls the mock provider with `idempotencyKey = notification id`, marks `SENT`.
- [ ] The mock provider records deliveries and dedupes by key.
- [ ] AT-15: hold → order → payment succeeded → `CONFIRMED`, `APPLIED`, seats `SOLD`, one confirmation record.
- [ ] AT-14 (second half): with `+dup@`, exactly one notification record per channel.
- [ ] External delivery is documented as at-least-once.
