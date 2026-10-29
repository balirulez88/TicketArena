# 03: Seeded catalog and seat-map API

**What to build:** the database holds seeded venues, sections, rows, seats and events (including one `demo` event), and the API lists events, shows one event, and returns its seat map with each seat's status and section price. Spec: Catalog, Data model (booking).

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Schema for venue, section (price in integer minor units, currency EUR), seat (status `AVAILABLE | HELD | IN_CHECKOUT | SOLD`, `holdId?`, `claimBuyerKey?`) and event (`onSaleAt`, `queueOpensAt`, `queueClosesAt`, `demo` flag); multiSchema configured with the `public` schema.
- [ ] An idempotent seed script creates 1–2 venues, 2–3 events and one demo event.
- [ ] `events.list`, `events.get` and `seats.map` return validated, typed results; unknown ids give `NOT_FOUND`.
- [ ] Integration tests run the procedures against real Postgres.
- [ ] `docs/database` lists the new tables.
