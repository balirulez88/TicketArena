# 41: Booking and catalog correctness fixes

**What to build:** the correctness fixes found by the review of tickets 03–05, so that what a buyer is charged is exactly the seat set that was validated and locked, malformed or stale holds fail with domain errors instead of internal errors, and the seed and seat lookups hold up under concurrency and load. Each criterion resolves the named entry of `docs/technical-debt.md`: set it `RESOLVED` with its `Resolution` and the test in `Verification`. Spec: Placing an order, Data model (booking); ADR 0003, ADR 0005.

**Type:** fix

**Blocked by:** 05

**Status:** blocked

- [ ] TD-019: `placeOrder` prices the order lines and the total, and moves seats to `IN_CHECKOUT`, using exactly the seat set it validated and locked (the hold's `seat.held` seat ids), never a `WHERE "holdId" = ...` query; a test with a seat that carries the hold's id but is outside that set proves the seat is neither priced nor mutated.
- [ ] TD-023: the order currency comes from the priced seats; seats of different currencies fail with a domain error instead of a mixed total, and no currency is invented by a fallback.
- [ ] TD-027: `placeOrder` refuses a hold that is not `HELD` before reading its `seat.held` event, and a missing `seat.held` event is a domain error (not an unhandled error / `INTERNAL_SERVER_ERROR`), with tests for both.
- [ ] TD-014: `holdSeats` rejects an empty or duplicated `seatIds` list with a domain error before writing anything, tested at the service level.
- [ ] TD-002: `venues.name` is unique (migration) and `seedCatalog` upserts venues; concurrent seed runs against one database leave exactly one row per venue.
- [ ] TD-012: `seats."holdId"` is indexed (migration and `schema.prisma`); a test asserts the index exists.
- [ ] `docs/database` documents the unique `venues.name` key and the `seats."holdId"` index, and `packages/db/src/docs.test.ts` asserts that every index and unique constraint the migrations create is named there. (Register updates are enforced by `check:debt` in the gate, not by this criterion.)
