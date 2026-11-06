# 49: Prisma schema drift

**What to build:** the Prisma schema is the source of truth for the database again: it matches every migration, and the quality gate fails whenever the two drift apart, so no later migration silently changes a column's type. Resolves TD-030 in `docs/technical-debt.md` (MEDIUM, CORRECTNESS). Spec: Data model; ADR 0009.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TD-030: `processed_messages.processedAt` is declared `@db.Timestamptz(3)` in `schema.prisma`, matching its migration; no new migration changes the column.
- [ ] A test in the quality gate compares the Prisma schema with the database the migrations produce (for example `prisma migrate diff` from the migrations to the schema datamodel, against the test database) and fails on any difference.
- [ ] That test fails when a model field's type disagrees with its migration (shown while writing it, for example with `processedAt` before the fix).
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 49 (TD-030) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
