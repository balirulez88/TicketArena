# Architecture

[← System map](../index.md)

## Module boundaries

| Workspace     | Responsibility                                                  | Depends on |
| ------------- | --------------------------------------------------------------- | ---------- |
| `apps/web`    | Next.js App Router UI and the tRPC API (the only public entry)  | (none yet) |
| `packages/db` | Prisma schema, migrations, client factory over the Neon adapter | (none)     |

Planned (created by tickets, not up front): a waiting-room module (Redis queue logic), a booking
module (seat state, holds, orders), an outbox relay worker, and payment/notification consumers.
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

`Browser → TRPCReactProvider (httpBatchLink, superjson) → /api/trpc/[trpc] → appRouter → procedure(ctx)`

## Children

None yet. Add `waiting-room.md`, `booking.md` here as those modules land (see `skills/update-docs.md`).
