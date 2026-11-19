# 62: Re-joining keeps a live admission

**What to build:** a buyer who already holds an admission slot and joins the queue again (a refresh, a second tab, a client retry) keeps that admission. Today `join` does not look at the active set, so the admitted session is queued again; when the ticker reaches it, the admit script replaces its `jti`, which revokes the admission the buyer is using. Must land before ticket 31 builds the admission token on the `jti`. Spec: Waiting room; ADR 0008. Raised in the review of PR #9.

**Blocked by:** 30

**Status:** done

**Completed:** 2026-11-19 on devflow/run-202611182140 (run 202611182140)

- [ ] `join` by a session that holds a slot returns an admitted result, adds nothing to the queue and leaves its `jti` and slot unchanged; the check and the queue write are one atomic script, so a tick running at the same time cannot admit the session twice.
- [ ] A contract test proves it on both adapters: admit a member, join it again, run more ticks; its original `jti` is still admitted and it holds exactly one slot.
- [ ] `queue.join` returns the admitted result to the client.
- [ ] A session whose slot was freed (leave, order placed, reaping) can join again and queues at the back as before.
- [ ] The waiting-room docs describe the rule.
