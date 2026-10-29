# 37: Race demo and demo reset

**What to build:** an operator can run a live 100-buyer race for one seat of the demo event and see exactly one winner, then reset the demo event to run it again. Spec: Admin dashboard.

**Blocked by:** 35, 10

**Status:** ready-for-agent

- [ ] `admin.runRace` works on the demo event only: 100 synthetic sessions call `BookingService.holdSeats` on one seat concurrently, in-process (admission is bypassed by design). It reports successes, `SEAT_UNAVAILABLE`, `BOOKING_BUSY` and duration, and the results appear in the feed.
- [ ] `admin.resetDemo` is allowed only when no demo order is `PENDING_PAYMENT` and no demo refund obligation is open. It clears demo holds, orders, ledger rows and Redis keys, and sets seats back to `AVAILABLE`; other services' history is kept.
- [ ] Both are rate-limited to 1 per 10s.
- [ ] AT-44: race and reset touch only the demo event and are rate-limited.
- [ ] AT-45: `admin.runRace` reports exactly one success.
