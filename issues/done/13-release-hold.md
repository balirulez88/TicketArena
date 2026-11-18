# 13: Release a hold

**What to build:** a buyer can give back a hold they no longer want, immediately freeing its seats for others. Spec: Releasing a hold.

**Blocked by:** 04

**Status:** done

**Completed:** 2026-11-18 on devflow/run-202611180958 (run 202611180958)

- [x] `booking.releaseHold` is owner-only (`NOT_FOUND` otherwise) and only for status `HELD`.
- [x] Hold → `RELEASED`; only seats whose `holdId` is this hold → `AVAILABLE`; outbox `hold.released`; one transaction.
- [x] Released seats can be held by another buyer immediately.
- [x] Releasing does not free the buyer's waiting-room slot (documented; slot logic arrives in ticket 30).
