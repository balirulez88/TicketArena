# 02: Guest session identity

**What to build:** every visitor gets a stable, signed anonymous session, and every tRPC procedure receives a `Principal` resolved by `IdentityService` instead of reading cookies. Spec: Identity; ADR 0012.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The Next.js 16 `proxy.ts` issues `ta_session` (random 128-bit id, HMAC-signed with `SESSION_SECRET`, `httpOnly`, `Secure`, `SameSite=Lax`, 7 days) on first visit.
- [ ] A cookie with an invalid signature yields a new session; the old value is never trusted.
- [ ] `IdentityService.resolve` returns `{ kind: "guest", sessionId }` and never throws for a guest; the result is placed on the tRPC context.
- [ ] `BuyerKey` is derived as `userId ?? sessionId`.
- [ ] `SESSION_SECRET` (at least 32 bytes) is validated in `parseServerEnv` with a field-naming error.
- [ ] `session.whoami` returns the principal; tested via `createCaller`.
- [ ] The guest-limit bypass (clearing cookies) is documented as a known MVP limitation.
