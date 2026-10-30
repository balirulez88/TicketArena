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
| 6    | `/code-review` (inside step 4) | Standards + Spec reports, per slice |

Skill sources and provenance: [`skills/README.md`](../../skills/README.md).

## Quality gate

`pnpm run check` = `lint` → `typecheck` → `test` → `test:harness`. All must pass with zero
warnings:

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
- **Harness tests** (`test:harness`): `node:test` for the review gate and bash scenarios that
  run `ralph-loop.sh` with stub agents and reviewers, proving the merge policy below.

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
- Compose publishes Postgres on host port **55432**, not 5432, so a natively installed Postgres
  cannot shadow it. Redis and NATS keep their default ports.
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
5. **REVIEW:** two independent reviewers judge the whole changeset (see below). Blocking
   findings go back to the agent (**FIX**, gated like GREEN), then a fresh review round.
6. **VERIFY:** the full gate runs once more on the approved tree.
7. Squash into **one** Conventional Commit, mark the ticket `done` in the same commit, merge
   `--no-ff` into `main` so dependent tickets build on it, and optionally push.

A ticket that cannot get through RED, GREEN, DOCS, REVIEW or VERIFY is **rejected**: its failing work is
committed to a quarantine branch `rejected/<NN>-<slug>-<run-id>` (never to a slice branch or
`main`), the ticket is marked `blocked` on `main`, and the loop stops for a human to look.
Agent transcripts, gate output and review reports are kept in `.ralph/logs/<run-id>/`
(git-ignored).

## Independent review

Ralph runs the portable [`code-review`](../../skills/code-review/README.md) skill in its
non-interactive mode. TicketArena's rules for reviewers are in [code-review.md](code-review.md).

- **Two axes, two processes.** The Standards and Spec reviewers run in parallel as separate,
  fresh `claude -p` processes; neither sees the other or the implementing agent's context. Their
  reports stay separate in `.ralph/logs/<run-id>/<slug>.review-<round>.md`.
- **Read-only by construction.** Reviewers get only Read, Grep and Glob (`--restricted`,
  `--strict-mcp-config`). If a review round leaves the repository changed anyway, the changes are
  discarded and the round fails.
- **What they review.** The complete changeset `git diff main...HEAD`, committed by the harness
  right before the review so new files are included, plus the ticket and the spec and ADRs it
  references. The changeset file lives in the git-ignored `.ralph/review/<run-id>/` inside the
  workspace (the reviewers' file access is confined to it), with a copy in the run logs.
- **Proof of reading.** The changeset ends with a random `review-token` line. Each report must
  echo it as `changeset_token`; a missing or wrong token makes the review invalid, so a reviewer
  that could not open the changeset cannot approve by reviewing other files instead.
- **Structured, validated reports.** Each reviewer must return JSON matching
  `skills/code-review/report.schema.json`: severity, file and line, rule, problem, impact,
  recommendation. `scripts/ralph-review.mjs` validates both reports and applies the policy.
- **Merge policy.** `CRITICAL` and `HIGH` findings block the merge (`RALPH_REVIEW_BLOCKING`);
  `MEDIUM` and `LOW` are logged, not blocking. A crashed or timed-out reviewer, an error result,
  invalid JSON, a skipped axis or a tampered tree is a **failed** review, never an approval.
- **Bounded.** Up to `RALPH_MAX_REVIEW_ROUNDS` (default 3) rounds; each round except the last
  may trigger a fix. A slice still blocked, or without a valid approval, after the last round is
  rejected and quarantined like any other failure.

## Sandbox

`Dockerfile` defines a Node 24 + pnpm + git + Claude Code image. `scripts/sandbox.sh` builds it
and runs the loop against a **clone** of the repo inside the container. The agent therefore
never touches the host working tree, and host-native `node_modules` (e.g. Windows binaries)
never mix with Linux ones. Green results are pushed back to the host repo's branches.
The image also contains Postgres 17, Redis 7 and nats-server (checksum-verified), started by the
entrypoint before the loop, so every slice is judged on real infrastructure.
**Failed runs keep their evidence on the host.** The host's `.ralph/logs/` is mounted into the
container, so logs land there as they are written, even if the run crashes. A rejection pushes the
quarantine branch `rejected/<NN>-<slug>-<run-id>` and the base branch with the ticket marked
`blocked`. The base branch only fast-forwards and the host repo refuses the push while it has
local changes (`receive.denyCurrentBranch=updateInstead`); the blocked status then lands on
`ralph/blocked-<run-id>` instead, to merge by hand. `pnpm test:sandbox` (Docker; also a CI job)
proves both cases through the real sandbox. On Linux hosts the container user (uid 1000) must be
able to write the repository and `.ralph/logs`.
`pnpm sandbox --verify` runs just the gate inside the sandbox (no agent, no API key): use it after
changing the image. Set `RALPH_BASE_BRANCH` to verify a branch other than `main`.
The agent runs with permission prompts disabled **only** inside the container
(`RALPH_SANDBOX=1`); the script refuses to do so elsewhere unless explicitly overridden.
