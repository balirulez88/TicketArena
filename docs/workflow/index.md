# Agent Workflow & Quality Gate

[← System map](../index.md)

## Pipeline

| Step | Skill / tool                   | Output                              |
| ---- | ------------------------------ | ----------------------------------- |
| 1    | `/grill-me` (→ `grilling`)     | Shared understanding, decisions     |
| 2    | `/to-spec`                     | `docs/specs/<feature>.md`           |
| 3    | `/to-tickets`                  | `issues/<NN>-<slug>.md`             |
| 4    | `ralph-loop.sh` (in sandbox)   | One green, atomic commit per ticket |
| 5    | `/update-docs` (inside step 4) | Updated `/docs` maps                |

Skill sources and provenance: [`skills/README.md`](../../skills/README.md).

## Quality gate

`pnpm run check` = `lint` → `typecheck` → `test`. All three must pass with zero warnings:

- **Biome** (`biome ci --error-on-warnings`): lint, formatting, import order. A warning is a
  failure. Fix with `pnpm run format`; never by loosening `biome.json` or `biome-ignore`.
  Excluded: vendored `skills/` (kept verbatim to upstream), generated code, `pnpm-lock.yaml`.
  The one disabled rule, `useLiteralKeys`, contradicts TypeScript's
  `noPropertyAccessFromIndexSignature`, which deliberately forces `process.env["X"]` so that
  unvalidated env access stands out.
- **TypeScript** strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`.
- **Vitest** behaviour tests at agreed seams: unit **and** integration tests in one gate
  ([ADR 0010](../adr/0010-real-infrastructure-tests.md)).

## Integration test infrastructure

Integration tests run against real **Postgres 17, Redis 7 and NATS JetStream**, never mocks.

| Where         | Services come from                                        | `TEST_*` variables come from   |
| ------------- | --------------------------------------------------------- | ------------------------------ |
| Developer     | `pnpm infra:up` (`docker-compose.yml`)                    | `.env.test` (copy the example) |
| CI            | the same `docker-compose.yml` in GitHub Actions           | the workflow                   |
| Ralph sandbox | native processes started by `scripts/sandbox-services.sh` | the entrypoint                 |
- `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_NATS_URL` are required. A missing one **fails**
  the run with a message naming it; integration tests are never skipped.
- `@ticketarena/test-infra` (test-only package, the one place test code reads the environment)
  provides the isolation helpers; packages with integration tests register its global setup.
- **Isolation per test file**, so files run in parallel:
  - `setupTestDatabase()`: a fresh database cloned from a migrated template. The global setup
    builds the template once per migration set (its name hashes the migrations) by applying the
    committed migration SQL; clones and template builds are serialized by a Postgres advisory
    lock. The clone is dropped after the file.
  - `setupTestRedis()`: a unique key prefix, deleted after the file.
  - `setupTestNats()`: a unique stream-name prefix and root subject token; streams deleted after.
- Versions are pinned identically in `docker-compose.yml` and the sandbox `Dockerfile`; NATS
  uses one shared config (`infra/nats/nats.conf`, JetStream with `sync_interval: always`).
- Stale template databases from old migration sets accumulate harmlessly; `pnpm infra:reset`
  wipes all local service data.

## CI

`.github/workflows/ci.yml` runs on every push and pull request: install, `docker compose up
--wait`, `pnpm run check`. Actions are pinned to commit SHAs.

## Ralph loop (`ralph-loop.sh`)

For each ticket whose `**Status:**` is `ready-for-agent` and whose blockers are all `done`:

1. Create branch `slice/<NN>-<slug>` from `main`.
2. **RED:** the agent writes failing test(s) for the first acceptance criterion. The harness
   requires a changed test file, lint passing, and `pnpm run test` **failing**. A test that
   passes before any implementation proves nothing and is rejected.
3. **GREEN:** the agent implements until the full gate passes. Gate output from a failed attempt
   is fed into the next one, up to `RALPH_MAX_ATTEMPTS`.
4. **REFACTOR + DOCS:** the agent runs the code-review/refactor pass and `update-docs`. The gate
   must stay green. If it does not, the refactor is discarded and the green state kept.
5. Squash into **one** Conventional Commit, mark the ticket `done` in the same commit, merge
   `--no-ff` into `main` so dependent tickets build on it, and optionally push.

A ticket that cannot get through RED, GREEN or DOCS is **rejected**: its failing work is
committed to a quarantine branch `rejected/<NN>-<slug>-<run-id>` (never to a slice branch or
`main`), the ticket is marked `blocked` on `main`, and the loop stops for a human to look.
Agent transcripts and gate output are kept in `.ralph/logs/<run-id>/` (git-ignored).

## Sandbox

`Dockerfile` defines a Node 24 + pnpm + git + Claude Code image. `scripts/sandbox.sh` builds it
and runs the loop against a **clone** of the repo inside the container. The agent therefore
never touches the host working tree, and host-native `node_modules` (e.g. Windows binaries)
never mix with Linux ones. Green results are pushed back to the host repo's branches.
The image also contains Postgres 17, Redis 7 and nats-server (checksum-verified), started by the
entrypoint before the loop, so every slice is judged on real infrastructure.
`pnpm sandbox --verify` runs just the gate inside the sandbox (no agent, no API key): use it after
changing the image. Set `RALPH_BASE_BRANCH` to verify a branch other than `main`.
The agent runs with permission prompts disabled **only** inside the container
(`RALPH_SANDBOX=1`); the script refuses to do so elsewhere unless explicitly overridden.
