# Architecture

[← System map](../index.md)

## Module boundaries

| Workspace            | Responsibility                                                                      | Depends on                   |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `apps/web`           | Next.js App Router UI and the tRPC API (the only public entry)                      | `db`, `booking`, `contracts` |
| `packages/db`        | Prisma schema, migrations, client factory over the Neon adapter                     | (none)                       |
| `packages/contracts` | Zod schemas for the event envelope and event payloads (`seat.held`, `order.placed`) | (none)                       |
| `packages/booking`   | `BookingService`: `holdSeats`, `getHold`, `placeOrder`, `getOrder`                  | `contracts`, `db`            |

Planned (created by tickets, not up front): a waiting-room module (Redis queue logic), an outbox relay worker, and payment/notification consumers.
New modules are added when a slice needs them, not speculatively.

## Conventions that shape the code

- **Dependency direction:** `apps/*` → `packages/*`, never the reverse. Packages must not read
  `process.env`; configuration is validated at the app boundary (`parseServerEnv`) and injected.
- **tRPC context as the composition root:** infrastructure (clock, db, redis, outbox) enters
  procedures through `TRPCContext`. Procedures never import a client directly, which keeps them
  testable through `createCaller` with fakes at system boundaries only.
- **Deep modules, narrow interfaces:** each module exposes a small surface (e.g.
  `enqueue/position/admit` for the waiting room) and hides its storage layout.
- **Packages ship TypeScript source** (`exports` → `src/index.ts`); there is no package build
  step. Turborepo caches `typecheck`, `test`, `build` and `db:generate`.
- **Errors:** validate at boundaries (zod), fail fast with actionable messages, and surface
  domain failures as typed tRPC errors rather than thrown strings.

## Request path today

`Browser → proxy.ts (ensures ta_session) → TRPCReactProvider (httpBatchLink, superjson) → /api/trpc/[trpc] → createTRPCContext (resolves Principal, attaches `db`) → appRouter → procedure(ctx)`

## Identity

Decision: [ADR 0012](../adr/0012-identity-service-seam.md). Code: `apps/web/src/server/identity/`.

- **Session cookie:** `apps/web/src/proxy.ts` (Next.js 16 `proxy.ts`) issues `ta_session` on first
  visit: a random 128-bit id plus its HMAC-SHA256 under `SESSION_SECRET`; `httpOnly`, `Secure`,
  `SameSite=Lax`, 7 days. A cookie whose signature fails is replaced, never trusted or repaired.
  Signing uses Web Crypto so the proxy and route handlers share one implementation. When the
  proxy issues a cookie it also forwards it on the downstream request, so the first request
  resolves the same session the browser receives.
- **`IdentityService.resolve(cookies)`** returns a `Principal` and never throws for a guest. With
  no trusted cookie it returns an ephemeral session id; the proxy is what persists a fresh one.
- **Context seam:** `createTRPCContext` resolves the `Principal` once per request and puts it on
  `TRPCContext`. Procedures read `ctx.principal`, never cookies. `Principal` is a discriminated
  union (`guest` has no `userId`; `user` always has one). `buyerKey(principal)` is the `userId`
  for a user and the `sessionId` for a guest, so phase-2 authentication will not change booking procedures.
- **Config:** `SESSION_SECRET` (at least 32 bytes) is validated in `parseServerEnv`; the error
  names the field. The proxy and `createTRPCContext` use `parseSessionEnv`, which validates only
  that variable, so an unrelated missing setting (e.g. the Redis token) cannot break page requests.
- **Known MVP limitation:** clearing cookies yields a new guest session, so per-session guest
  limits (e.g. the 6-ticket limit) can be bypassed until authentication exists.
- **API:** `session.whoami` returns the caller's principal.

## Catalog API

Routers in `apps/web/src/server/routers/`: `events` (`list`, `get`) and `seats` (`map`), sharing
zod schemas in `catalog-schemas.ts`. They read through `ctx.db`, a process-wide Prisma client
created lazily from `DATABASE_URL` (`parseDatabaseEnv` validates only that variable). A missing
event is a `NOT_FOUND` tRPC error. Integration tests run against real Postgres. See
[database](../database/index.md).

## Children

None yet. Add `waiting-room.md`, `booking.md` here as those modules land (see `skills/update-docs.md`).
