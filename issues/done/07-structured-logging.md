# 07: Structured logging with correlation and causation ids

**What to build:** web and worker emit JSON logs where every line about a booking carries its `correlationId` and `causationId` (plus `holdId`, `orderId`, `paymentId` when known), so one booking can be traced across both apps. Spec: Observability.

**Blocked by:** 06

**Status:** done

**Completed:** 2026-11-03 by slice/07-structured-logging (run 20261103-123322)

- [x] A `pino` logger is created at each app boundary and injected; packages do not create loggers from global state.
- [x] Booking procedures, the relay and the consumer runner log with a child logger bound to the envelope's ids.
- [x] Events written in response to a message carry `causationId` = the handled message's id and the unchanged `correlationId`.
- [x] Tests assert the ids on emitted events (not on log formatting).
- [x] `docs/architecture` describes the logging and id conventions.
