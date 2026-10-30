# 02: Guest session identity

**What to build:** every visitor gets a stable, signed anonymous session, and every tRPC procedure receives a `Principal` resolved by `IdentityService` instead of reading cookies. Spec: Identity; ADR 0012.

**Blocked by:** 01

**Status:** done

- [x] The Next.js 16 `proxy.ts` issues `ta_session` (random 128-bit id, HMAC-signed with `SESSION_SECRET`, `httpOnly`, `Secure`, `SameSite=Lax`, 7 days) on first visit.
- [x] A cookie with an invalid signature yields a new session; the old value is never trusted.
- [x] `IdentityService.resolve` returns `{ kind: "guest", sessionId }` and never throws for a guest; the result is placed on the tRPC context.
- [x] `BuyerKey` is derived as `userId ?? sessionId`.
- [x] `SESSION_SECRET` (at least 32 bytes) is validated in `parseServerEnv` with a field-naming error.
- [x] `session.whoami` returns the principal; tested via `createCaller`.
- [x] The guest-limit bypass (clearing cookies) is documented as a known MVP limitation.
