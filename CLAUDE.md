# CLAUDE.md

Agent instructions for TicketArena. Humans: see `README.md`.

## Orient first

1. `docs/index.md`: system map and **open decisions**. Then the area index you are touching.
2. `docs/glossary.md`: use these terms exactly in code, tests and prose.
3. `docs/adr/`: accepted decisions. Do not contradict one; propose a superseding ADR instead.

## Workflow

`/grill-me` → `/to-spec` → `/to-tickets` → `ralph-loop.sh` (`/implement` + `/tdd` → `/update-docs`
→ independent `/code-review` → fix → merge).
Skill sources live in `skills/`; `.claude/skills/*` are thin wrappers.

## Quality gate (all must pass, zero warnings)

```bash
pnpm run lint       # biome ci --error-on-warnings
pnpm run typecheck  # tsc strict in every workspace
pnpm run test       # vitest
pnpm run test:harness  # ralph-loop review policy, evidence gate, artifact retention (bash, node:test)
pnpm run check      # all of the above
pnpm test:sandbox   # Docker: a rejected sandbox run keeps logs, branch and status on the host
pnpm infra:up       # local Postgres/Redis/NATS for integration tests (TEST_* in .env.test)
pnpm run format     # auto-fix formatting + import order
```

Never weaken the gate: no `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `any`, non-null `!`,
skipped tests, or edits that relax `biome.json` / `tsconfig.base.json`.

## Code conventions

- **TDD at agreed seams** (`skills/tdd.md`): test behaviour through public interfaces; mock only
  system boundaries (network, time, randomness), never our own modules.
- **SOLID, small deep modules**: narrow interfaces that hide storage and protocol details.
- **Dependency injection**: packages never read `process.env`; apps validate config at the
  boundary (`parseServerEnv`) and inject it. Procedures receive infrastructure via tRPC context.
- **Defensive at boundaries**: validate all external input with zod; fail fast with messages
  that name the offending field. Trust validated data internally; do not re-check everywhere.
- **Comments explain WHY**: architectural intent, concurrency and consistency guarantees, state
  mutations with non-obvious invariants. Never narrate what the code plainly does.
- **Distributed-systems rules**: anything another service must learn about goes through the
  outbox in the same transaction; consumers are idempotent; seat state is never decided by
  Redis alone.
- Named exports only, except where Next.js requires default exports (pages, layouts, configs).
- Conventional Commits: `type(scope): subject`.

## Code review

`/code-review <fixed-point>` runs the generic two-axis review (`skills/code-review/`). Its
TicketArena-specific rules live in [`docs/workflow/code-review.md`](docs/workflow/code-review.md):
reviewers must read that file. Ralph reviews every slice before merging; `CRITICAL`/`HIGH`
findings block the merge.

## Layout

```text
apps/web          Next.js App Router + tRPC API
packages/db       Prisma schema, migrations, client factory (Neon adapter)
docs/             architecture memory (keep current via skills/update-docs.md)
issues/           local ticket tracker (contract: issues/README.md); issues/done/ = completed
                  tickets, history only: read one only when the current ticket refers to it
skills/           workflow skills (vendored from mattpocock/skills + local)
ralph-loop.sh     autonomous TDD harness; runs inside the Docker sandbox
```
