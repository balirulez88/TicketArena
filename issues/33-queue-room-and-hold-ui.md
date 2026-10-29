# 33: Queue room and hold UI

**What to build:** a buyer queues for an event, watches their position, moves to the seat map when admitted, holds seats with a live countdown, and can release the hold. Spec: Frontend, Waiting room.

**Blocked by:** 31, 32, 13

**Status:** ready-for-agent

- [ ] The queue room shows position and ETA, polls `queue.status` every 3s, and advances automatically on admission.
- [ ] Holding shows `SEAT_UNAVAILABLE` (with the taken seats), `LIMIT_EXCEEDED`, `BOOKING_BUSY` and `FORBIDDEN` as distinct messages.
- [ ] A countdown to the server's `holdExpiresAt`, and a release button.
- [ ] The seat map and checkout keep polling, so the heartbeat continues.
