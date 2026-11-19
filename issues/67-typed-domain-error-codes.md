# 67: Typed domain error codes for the client

**What to build:** the web client tells booking errors apart by a typed code, not by parsing message text. Today `SEAT_UNAVAILABLE` and `LIMIT_EXCEEDED` both arrive as tRPC `CONFLICT`, and the hold UI reads the domain code and the taken seat ids out of the error message. The tRPC error formatter now adds the domain code (and, for `SEAT_UNAVAILABLE`, the taken seat ids) to the error's `data`, and the UI reads them from there. Follows the answer recorded for ticket 33 in `.devflow/questions.md`.

**Blocked by:** 33, 34

**Status:** ready-for-agent

- [ ] Every booking domain error mapped by the routers (`SEAT_UNAVAILABLE`, `LIMIT_EXCEEDED`, `HOLD_EXPIRED`, `HOLD_NOT_ACTIVE`, `NOT_ON_SALE`, `IDEMPOTENCY_KEY_REUSED`, ...) reaches the client with its code in `error.data.domainCode`; `SEAT_UNAVAILABLE` also carries `error.data.seatIds`.
- [ ] Errors that are not domain errors carry no `domainCode`, and internal details never leak into `data`.
- [ ] The hold and checkout UI read `domainCode` and `seatIds` only; no client code parses an error message.
