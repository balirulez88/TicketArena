# 49: Prisma schema drift

**What to build:** the Prisma schema is the source of truth for the database again: it matches every migration, and the quality gate fails whenever the two drift apart, so no later migration silently changes a column's type. Resolves TD-030 in `docs/technical-debt.md` (MEDIUM, CORRECTNESS). Spec: Data model; ADR 0009.

**Worked by hand, before the next Ralph production run (maintainer decision, 2026-11-14):** today `db:migrate` (`prisma migrate dev`) would add a silent `ALTER` of `processed_messages.processedAt` to any slice that creates a migration, and nothing in the gate would notice. The fix must therefore not depend on an unguarded slice that itself contains a migration: it adds no migration at all, and the drift test that guards every later migration lands first. It is implemented in Claude Code and reviewed outside Ralph (status `ready-for-human`), like ticket 52; either may go first.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [ ] Drift test first: a test in the quality gate (`pnpm run test`, against the test database) compares the Prisma schema with the database the committed migrations produce (for example `prisma migrate diff` from the migrations directory to the schema datamodel) and fails on any difference, naming it. It is committed and shown failing on the unfixed schema before the fix (the failing run is recorded in the review evidence).
- [ ] That test fails when a model field's type disagrees with its migration, and when a migration changes something the schema does not declare (two sabotage runs, recorded: reverting the `processedAt` annotation; adding a column only in a scratch migration).
- [ ] TD-030: `processed_messages.processedAt` is declared `@db.Timestamptz(3)` in `schema.prisma`, matching its migration. No migration is added or changed by this ticket. Check: `git diff --name-only main -- packages/db/prisma/migrations` is empty.
- [ ] After the fix, the drift test passes on the full schema (all three service schemas), and running `prisma migrate dev --create-only` on the fixed schema produces no migration (recorded).
- [ ] Independent Standards and Spec reviews approve the change; the full quality gate (`pnpm run check`) and GitHub CI pass.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 49 (TD-030) is `RESOLVED`, with the tests that prove it named in `Verification` (`node scripts/ralph-debt.mjs slice docs/technical-debt.md --base <main's register> --ticket 49` passes).

**Documentation deliverable (reviewed, not test-verified):** `docs/database/index.md` says that a schema change goes through `db:migrate`, that the drift test in the gate rejects a schema and migrations that disagree, and how to read its failure.
