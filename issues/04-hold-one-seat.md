# 04: Hold one seat

**What to build:** a buyer can hold one available seat (no queue yet) and see the hold with its expiry; the hold is written together with a `seat.held` outbox event carrying a newly minted `correlationId`. Spec: Holding seats, Messaging (envelope); ADR 0005.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [ ] The `contracts` package defines the event envelope (`id`, `type`, `version`, `occurredAt`, `correlationId`, `causationId`, `holdId?`, `orderId?`, `payload`) and the `seat.held` payload with zod.
- [ ] Hold schema: `id`, `eventId`, `sessionId`, `userId?`, `buyerKey`, `status` (`HELD | ORDERED | RELEASED | EXPIRED`), `holdExpiresAt`, `correlationId`; booking outbox table in the `public` schema.
- [ ] `BookingService.holdSeats` locks the seat with `SELECT … FOR UPDATE`, reads `T = clock.now()` after the lock, sets the seat `HELD` with `holdId` and `claimBuyerKey`, sets `holdExpiresAt = T + 10 min`, writes `seat.held`, all in one transaction.
- [ ] A seat that is not `AVAILABLE` returns `SEAT_UNAVAILABLE` with its id.
- [ ] `booking.holdSeats` and `booking.getHold` (owner only, else `NOT_FOUND`) exposed via tRPC; tested via `createCaller`.
- [ ] `Clock` is injected; no SQL `now()`.
