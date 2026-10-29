# 31: Admission token enforcement

**What to build:** seats can only be held by buyers the waiting room admitted for that event in that session. Checkout of a valid hold keeps working even after the admission expires. Spec: Waiting room (admission token); ADR 0008.

**Blocked by:** 30, 05

**Status:** ready-for-agent

- [ ] On the admitted session's next `queue.status` poll, the web app mints a JWT (HS256, `ADMISSION_SECRET`) with `sub`, `eid`, `jti` and `exp = admittedAt + 30 min`, in the httpOnly cookie `ta_adm_<eventId>`.
- [ ] `admittedProcedure` checks the signature, `exp`, `sub = principal.sessionId`, `eid = input.eventId`, and that the `jti` is in the admitted set; otherwise `FORBIDDEN`. Only `holdSeats` uses it.
- [ ] `ADMISSION_SECRET` (at least 32 bytes) is validated in `parseServerEnv`.
- [ ] AT-40: no token, an expired token, another session's token, another event's token, or a revoked `jti` → `FORBIDDEN`.
- [ ] AT-41: `placeOrder` succeeds with an expired admission when the hold is valid, and fails for a hold owned by another buyer.
