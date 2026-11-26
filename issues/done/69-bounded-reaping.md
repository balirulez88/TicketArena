# 69: Bounded reaping of active slots

**What to build:** one reaper pass does a bounded amount of Redis work, however many buyers hold a slot. `REAP_SCRIPT` reads the whole `active` set and checks every member in one atomic Lua call. While the queue is open, `maxActive` bounds that set; after the queue closes, immediate admission bypasses `maxActive`, so the set grows with every buyer seen in the last 90 seconds, and one long script blocks the event's other queue operations and admission checks meanwhile. Immediate admission stays as it is. Raised in the review of PR #12.

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261153 (run 202611261153)

- [ ] One reap call examines at most a configured batch of slots (idle candidates selected by `lastSeenAt` score, expired admissions by expiry) and reports whether more remain; the reaper repeats calls until none remain or the pass budget is spent.
- [ ] A contract test on both `QueueStore` adapters shows that one call frees at most the batch size from a set larger than it, and that repeated calls free every idle or expired slot and nothing else.
- [ ] Reaping still frees a slot and revokes its `jti` in the same step (AT-39), and the existing reaper tests stay green.

**Documentation deliverable (reviewed, not test-verified):** the waiting-room docs describe the batch size and why one reap call is bounded.
