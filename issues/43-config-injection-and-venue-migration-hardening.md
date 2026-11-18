# 43: Config injection and venue migration hardening

**What to build:** before anything is deployed, configuration reaches packages only through validated app boundaries, a request that does not touch the database does not need `DATABASE_URL`, and the unique-venue migration succeeds on a database that already holds duplicate venue names. Resolves TD-001, TD-003, TD-010, TD-011 and TD-028 in `docs/technical-debt.md`; must merge before ticket 38.

**Blocked by:** None (can start immediately)

**Status:** deferred

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

- [ ] TD-001: `packages/db` never reads `process.env`; the seed's database URL is validated at an app or script boundary and injected (a test fails if any file under `packages/*/src` outside tests reads `process.env`).
- [ ] TD-003: a tRPC procedure that does not use the database succeeds when `DATABASE_URL` is unset, while a procedure that needs it still fails fast with a message naming `DATABASE_URL` (tests for both).
- [ ] TD-028: on a database migrated to just before the unique `venues.name` migration and seeded with two venues of the same name, each with sections and events, the migration succeeds: one venue per name remains and every section and event points at the surviving venue (integration test against real Postgres).
- [ ] TD-028: the duplicate-merge rule (which row survives, how references are repointed) is documented in `docs/database`, verified by the docs test.
- [ ] TD-010: `seedCatalog` is not exported from the runtime entry point of `@ticketarena/db` (`packages/db/src/index.ts`); tests and the seed command reach it through a separate entry point (for example a `./seed` subpath export). Test: the runtime module's export names do not include `seedCatalog`, and the seed entry point's do. Sabotage: re-exporting it from `index.ts` turns it red.
- [ ] TD-011: the seed command itself (the entry point TD-001 moves to a validated boundary) is run by a test against the test database: with a valid URL it seeds the catalog and exits zero; without one it exits non-zero with a message naming the missing variable. Sabotage: breaking the entry point (for example not awaiting the seed, or not disconnecting) turns it red.
- [ ] The register entries TD-001, TD-003, TD-010, TD-011 and TD-028 are `RESOLVED` with the verifying tests named in `Verification`.
