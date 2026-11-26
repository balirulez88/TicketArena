# 68: A reload restores the active hold

**What to build:** a buyer who reloads the event page during a hold sees the hold again, with its countdown, release and checkout. Today the hold lives only in the `holdSeats` mutation's result, so a reload hides it while its seats stay held for up to 10 minutes and still count against the buyer limit. Follows the answer recorded for ticket 33 in `.devflow/questions.md`.

**Blocked by:** 33, 34

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261153 (run 202611261153)

- [x] `booking.activeHold({ eventId })` returns the current session's `HELD`, unexpired hold for the event (hold id, seats with prices, `holdExpiresAt`) or `null`; an expired hold that is not swept yet is `null`; another session's hold is never returned.
- [x] After a reload the event page shows the active hold with its countdown, and the buyer can release it or check out as before.
- [x] A hold that expires or is released while the page is closed is not shown after a reload.
