# 40: Guest session first-visit consistency

**What to build:** a visitor's very first request is served under the same guest session as the `ta_session` cookie the proxy issues on it, so nothing done during that request belongs to a session the browser never holds. Follow-up to ticket 02 from its independent review (MEDIUM findings, not accepted as limitations). Spec: Identity (`Principal`, `IdentityService`, session cookie); ADR 0012.

**Blocked by:** 02

**Status:** done

**Completed:** 2026-10-30 by slice/40-guest-session-first-visit-consistency (merge 35f04b1)

- [x] When the proxy issues a new `ta_session` (no cookie, or one with an invalid signature), it also forwards that cookie on the request passed downstream, so `createTRPCContext` resolves a `Principal` whose `sessionId` is the issued cookie's id. A test drives a cookie-less request through `proxy` and then `createTRPCContext` with the forwarded request and asserts the ids match.
- [x] Integration tests cover `createTRPCContext` itself (not a hand-built context): a valid signed cookie yields that session; a missing cookie and an invalid signature each yield a valid guest without throwing; the invalid cookie's id is never used.
- [x] The proxy validates only the configuration it uses (`SESSION_SECRET`), with a field-naming error; an unrelated missing or invalid variable (e.g. the Redis token) does not break page requests. `parseServerEnv` still validates the full server config.
- [x] `Principal` is the spec's discriminated union `{ kind: "guest", sessionId } | { kind: "user", sessionId, userId }`; `buyerKey` and its tests use only valid principals.
- [x] Behaviour stays within ADR 0012: no new dependencies, no change to the cookie format or its attributes.
