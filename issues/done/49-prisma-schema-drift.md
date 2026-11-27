# 49: Prisma schema drift

**What to build:** the Prisma schema is the source of truth for the database again: it matches every migration, and the quality gate fails whenever the two drift apart, so no later migration silently changes a column's type. Resolves TD-030 in `docs/technical-debt.md` (MEDIUM, CORRECTNESS). Spec: Data model; ADR 0009.

**Worked by hand, before the next Ralph production run (maintainer decision, 2026-11-14):** today `db:migrate` (`prisma migrate dev`) would add a silent `ALTER` of `processed_messages.processedAt` to any slice that creates a migration, and nothing in the gate would notice. The fix must therefore not depend on an unguarded slice that itself contains a migration: it adds no migration at all, and the drift test that guards every later migration lands first. It is implemented in Claude Code and reviewed outside Ralph (status `ready-for-human`), like ticket 52; either may go first.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-27 by fix/49-prisma-schema-drift (worked by hand in Claude Code)

- [x] Drift test first: a test in the quality gate (`pnpm run test`, against the test database) compares the Prisma schema with the database the committed migrations produce (for example `prisma migrate diff` from the migrations directory to the schema datamodel) and fails on any difference, naming it. It is committed and shown failing on the unfixed schema before the fix (the failing run is recorded in the review evidence).
- [x] That test fails when a model field's type disagrees with its migration, and when a migration changes something the schema does not declare (two sabotage runs, recorded: reverting the `processedAt` annotation; adding a column only in a scratch migration).
- [x] TD-030: `processed_messages.processedAt` is declared `@db.Timestamptz(3)` in `schema.prisma`, matching its migration. No migration is added or changed by this ticket. Check: `git diff --name-only main -- packages/db/prisma/migrations` is empty.
- [x] After the fix, the drift test passes on the full schema (all three service schemas), and running `prisma migrate dev --create-only` on the fixed schema produces no migration (recorded).
- [ ] Independent Standards and Spec reviews approve the change; the devflow gate (lint, typecheck, test) and GitHub CI pass. (`pnpm run check` also runs the frozen harness's self-tests, which CLAUDE.md keeps out of a ticket.)
- [x] ~~Every entry in `docs/technical-debt.md` whose Target is ticket 49 (TD-030) is `RESOLVED`~~ Superseded by ADR 0024 (the register is frozen): the TD-030 verification is recorded below instead.

**Documentation deliverable (reviewed, not test-verified):** `docs/database/index.md` says that a schema change goes through `db:migrate`, that the drift test in the gate rejects a schema and migrations that disagree, and how to read its failure.

## Verification (TD-030)

Test: `packages/db/src/schema-drift.test.ts` :: "the schema declares exactly what the committed migrations build, in all three service schemas". It runs `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code` against a database cloned from the template that test-infra builds by applying every committed migration, and expects an empty script.

Recorded runs (2026-11-27, local Postgres from `pnpm infra:up`):

1. **Unfixed schema, test committed first:** FAIL with
   `ALTER TABLE "processed_messages" ALTER COLUMN "processedAt" SET DATA TYPE TIMESTAMP(3);`
   This was the only difference across `public`, `payment` and `notification`.
2. **Fixed schema** (`@db.Timestamptz(3)` on `ProcessedMessage.processedAt`): PASS.
3. **Sabotage, field type:** the annotation was reverted, giving FAIL with the same `SET DATA TYPE TIMESTAMP(3)` statement. The annotation was then restored.
4. **Sabotage, scratch migration:** a temporary `29991231000000_scratch_drift` migration added `processed_messages.scratchOnly`. The run was FAIL with `ALTER TABLE "processed_messages" DROP COLUMN "scratchOnly";`, and the migration was then deleted.
5. **`prisma migrate dev --create-only --name drift_check`** on the fixed schema, against a fresh empty database: Prisma applied the four committed migrations and wrote only `-- This is an empty migration.`, with no statements. The generated folder and the scratch database were deleted.

`git diff --name-only main -- packages/db/prisma/migrations` is empty.
