# 43: Config injection and venue migration hardening

**What to build:** before anything is deployed, configuration reaches packages only through validated app boundaries, a request that does not touch the database does not need `DATABASE_URL`, and the unique-venue migration succeeds on a database that already holds duplicate venue names. Resolves TD-001, TD-003 and TD-028 in `docs/technical-debt.md`; must merge before ticket 38.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TD-001: `packages/db` never reads `process.env`; the seed's database URL is validated at an app or script boundary and injected (a test fails if any file under `packages/*/src` outside tests reads `process.env`).
- [ ] TD-003: a tRPC procedure that does not use the database succeeds when `DATABASE_URL` is unset, while a procedure that needs it still fails fast with a message naming `DATABASE_URL` (tests for both).
- [ ] TD-028: on a database migrated to just before the unique `venues.name` migration and seeded with two venues of the same name, each with sections and events, the migration succeeds: one venue per name remains and every section and event points at the surviving venue (integration test against real Postgres).
- [ ] TD-028: the duplicate-merge rule (which row survives, how references are repointed) is documented in `docs/database`, verified by the docs test.
- [ ] The register entries TD-001, TD-003 and TD-028 are `RESOLVED` with the verifying tests named in `Verification`.
