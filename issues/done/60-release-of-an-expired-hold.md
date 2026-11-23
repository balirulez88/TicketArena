# 60: Releasing an expired hold answers HOLD_EXPIRED

**What to build:** a buyer who tries to release a hold whose expiry has passed gets the same answer as when they try to order it: the hold has expired. This holds whether or not the sweeper has already marked it `EXPIRED`, because a hold is valid only while `T < holdExpiresAt`. The seats end up `AVAILABLE` either way; only the answer to the buyer changes. Follows the answers recorded for tickets 13 and 14 in `.devflow/questions.md`. Update the hold error table in the database docs to match.

**Blocked by:** 13, 14

**Status:** done

**Completed:** 2026-11-23 on devflow/run-202611231133 (run 202611231133)

- [ ] Releasing a `HELD` hold whose `holdExpiresAt <= T` (not yet swept) gives `HOLD_EXPIRED` and changes nothing: the hold stays `HELD` for the sweeper, no `hold.released` event is written.
- [ ] Releasing a hold the sweeper already moved to `EXPIRED` gives `HOLD_EXPIRED`.
- [ ] Releasing a hold one millisecond before `holdExpiresAt` still succeeds.
- [ ] Releasing a `RELEASED` or ordered hold still gives `HOLD_NOT_ACTIVE`.
- [ ] Through the API, `booking.releaseHold` maps `HOLD_EXPIRED` to the same tRPC error code `placeOrder` uses for it.
