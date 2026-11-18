# CLAUDE.md

Agent instructions for TicketArena. Humans: see `README.md`.

## Orient first

1. `docs/index.md`: system map and **open decisions**. Then the area index you are touching.
2. `docs/glossary.md`: use these terms exactly in code, tests and prose.
3. `docs/adr/`: accepted decisions. Do not contradict one; propose a superseding ADR instead.

## Workflow

The **devflow** Claude Code plugin drives the work (installed per machine; config in
`.devflow/config.json`):
`/devflow:grill-me` → `/devflow:to-spec` → `/devflow:to-tickets` → `/devflow:run`, with
`/devflow:status` and `/devflow:stop` during a run. A run implements one ticket at a time
test-first, gates it, reviews it once, and commits it on a `devflow/run-*` branch; it never pushes.
Questions it answered itself are in `.devflow/questions.md`.

The previous harness (`ralph-loop.sh`, `scripts/ralph-*`, the Docker sandbox) is **frozen** at the
`harness-v1` tag: do not extend or fix it, and do not run it.

## Quality gate (all must pass, zero warnings)

```bash
pnpm infra:up       # local Postgres/Redis/NATS for integration tests (TEST_* in .env.test)
pnpm run lint       # biome ci --error-on-warnings
pnpm run typecheck  # tsc strict in every workspace
pnpm run test       # vitest
pnpm run format     # auto-fix formatting + import order
```

These four checks are the devflow gate. `pnpm run check` additionally runs the frozen harness's
self-tests (`test:harness`, `check:debt`); it is not part of a ticket.

Never weaken the gate: no `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `any`, non-null `!`,
skipped tests, or edits that relax `biome.json` / `tsconfig.base.json`.

## Code conventions

- **TDD at agreed seams** (`/devflow:tdd`): test behaviour through public interfaces; mock only
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

TicketArena-specific review rules live in
[`docs/workflow/code-review.md`](docs/workflow/code-review.md): reviewers must read that file.
A devflow run reviews every ticket once; only `CRITICAL`/`HIGH` findings block, and
`MEDIUM`/`LOW` findings go into the commit message as follow-ups.

## Technical debt

[`docs/technical-debt.md`](docs/technical-debt.md) is a **frozen record** of findings from the
harness-v1 era. It is not part of any ticket and is not updated by runs. Read an entry only when it
explains a problem in code you are changing. New follow-ups live in commit messages; a human
decides which become tickets.

## Layout

```text
apps/web          Next.js App Router + tRPC API
packages/db       Prisma schema, migrations, client factory (Neon adapter)
docs/             architecture memory (keep current via skills/update-docs.md)
issues/           local ticket tracker (contract: issues/README.md); issues/done/ = completed
                  tickets, history only: read one only when the current ticket refers to it
.devflow/         devflow config and the record of questions a run answered itself
skills/           harness-v1 skills (frozen; devflow ships its own)
ralph-loop.sh     harness v1 (frozen at the harness-v1 tag)
```
