# 43: Config injection and venue migration hardening

**What to build:** before anything is deployed, configuration reaches packages only through validated app boundaries, a request that does not touch the database does not need `DATABASE_URL`, and the unique-venue migration succeeds on a database that already holds duplicate venue names. Resolves TD-001, TD-003, TD-010, TD-011 and TD-028 in `docs/technical-debt.md`; must merge before ticket 38.

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261713 (run 202611261713)

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

- [x] TD-001: `packages/db` never reads `process.env`; the seed's database URL is validated at an app or script boundary and injected (a test fails if any file under `packages/*/src` outside tests reads `process.env`).
- [x] TD-003: a tRPC procedure that does not use the database succeeds when `DATABASE_URL` is unset, while a procedure that needs it still fails fast with a message naming `DATABASE_URL` (tests for both).
- [x] TD-028: on a database migrated to just before the unique `venues.name` migration and seeded with two venues of the same name, each with sections and events, the migration succeeds: one venue per name remains and every section and event points at the surviving venue (integration test against real Postgres).
- [x] TD-028: the duplicate-merge rule (which row survives, how references are repointed) is documented in `docs/database`, verified by the docs test.
- [x] TD-010: `seedCatalog` is not exported from the runtime entry point of `@ticketarena/db` (`packages/db/src/index.ts`); tests and the seed command reach it through a separate entry point (for example a `./seed` subpath export). Test: the runtime module's export names do not include `seedCatalog`, and the seed entry point's do. Sabotage: re-exporting it from `index.ts` turns it red.
- [x] TD-011: the seed command itself (the entry point TD-001 moves to a validated boundary) is run by a test against the test database: with a valid URL it seeds the catalog and exits zero; without one it exits non-zero with a message naming the missing variable. Sabotage: breaking the entry point (for example not awaiting the seed, or not disconnecting) turns it red.
- [x] TD-028: same-name sections merge only if their `priceMinor` and `currency` match, so every existing seat keeps its price and currency; on a conflict the migration aborts before changing a row, with an error naming the venue, the section and each section's price and currency, and no seat is lost.
- [x] The verifying tests for TD-001, TD-003, TD-010, TD-011 and TD-028 are recorded below. Under [ADR 0024](../../docs/adr/0024-frozen-debt-register-check.md) the frozen register `docs/technical-debt.md` is not edited; this ticket is where its resolution is recorded.

## Verification

- **TD-001:** `packages/db/src/no-process-env.test.ts::packages read no environment > no file under packages/*/src outside tests reads process.env` (generated Prisma code and the `test-infra` environment boundary are exempt); `apps/worker/src/seed-main.test.ts::db:seed > exits non-zero naming DATABASE_URL when it is missing`.
- **TD-003:** `apps/web/src/server/lazy-database.test.ts::DATABASE_URL is read only by procedures that use the database > health.check and session.whoami succeed without it` and `> a procedure that needs the database fails fast naming DATABASE_URL`.
- **TD-010:** `packages/db/src/entry-points.test.ts::@ticketarena/db entry points > the runtime entry point does not export the seeder` and `> the seed entry point exports the seeder`.
- **TD-011:** `apps/worker/src/seed-main.test.ts::db:seed > seeds the catalog into the database DATABASE_URL names and exits zero` and `> exits non-zero naming DATABASE_URL when it is missing` (the command is `pnpm --filter @ticketarena/worker db:seed`).
- **TD-028:** `packages/db/src/venue-merge-migration.test.ts`: with matching section prices, `keeps one venue per name: the one with the lowest id`, `points every event at the surviving venue`, `moves sections to the survivor and merges a same-name section into the survivor's`, `sells every existing seat at the price and currency it had before the merge`, `merges same-label rows and keeps every seat, each on its venue's surviving rows`, `leaves the unique index in place`; with a differing price and with a differing currency, `aborts with an error naming the venue, the section, both prices and the fix` and `changes no venue, section or seat and does not create the unique index`. The rule's documentation: `packages/db/src/docs.test.ts::docs/database > documents the duplicate-venue merge rule next to the migration that applies it`.
