# 0012: Anonymous sessions behind an `IdentityService` seam

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

The MVP needs a stable buyer identity for queue position, holds, limits and order ownership, but
full authentication is phase 2 (registration, login, per-user limits, order history, ticket
management, guest and authenticated checkout).

## Decision

- `IdentityService.resolve(cookies) → Principal`, never throwing for a guest:
  `{ kind: "guest", sessionId }` now, `{ kind: "user", sessionId, userId }` in phase 2.
- `BuyerKey = userId ?? sessionId`. Limits and ownership key on `BuyerKey`; holds and orders store
  `sessionId` and a nullable `userId`.
- The session cookie `ta_session` holds a random 128-bit id signed with HMAC (`SESSION_SECRET`),
  `httpOnly`, `Secure`, `SameSite=Lax`, 7-day TTL, issued by the Next.js 16 `proxy.ts`. An invalid
  signature yields a fresh session; the old value is never trusted.
- The booking core never sees cookies, only a `Principal`.
- Admin access is separate: `ADMIN_PASSWORD` produces a signed admin cookie checked by
  `adminProcedure`.

## Alternatives considered

- **Auth.js now:** real per-account limits and stronger bot defence, at a large cost to the MVP.
- **No seam:** phase 2 would touch every booking procedure.

## Consequences

- **Known limitation:** guest limits are per session and can be bypassed by clearing cookies.
  Accepted for the MVP; per-user limits arrive with authentication.
