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
- **Harness tests** (`test:harness`): `node:test` for the review gate and the artifact
  lifecycle, and bash scenarios that run `ralph-loop.sh` with stub agents and a stub reviewer
  (`scripts/ralph-stub-reviewer.mjs`), proving the merge policy, the evidence gate and the
  retention rules below.

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
7. Squash into **one** Conventional Commit. In the same commit the ticket is marked `done`,
   stamped `**Completed:** <date> by slice/<NN>-<slug> (run <run-id>)` and moved to
   `issues/done/`. Merge `--no-ff` into `main` so dependent tickets build on it, and optionally
   push.

A ticket that cannot get through RED, GREEN, DOCS, REVIEW or VERIFY is **rejected**: its failing work is
committed to a quarantine branch `rejected/<NN>-<slug>-<run-id>` (never to a slice branch or
`main`), the ticket is marked `blocked` on `main`, and the loop stops for a human to look.
Agent transcripts, gate output and review reports are kept in `.ralph/logs/<run-id>/`
(git-ignored); see [Run artifacts](#run-artifacts) for what is kept and for how long.

### Context lifecycle: preserve verified work, not conversations

Every agent attempt (RED, GREEN, REFACTOR, DOCS, FIX) and every reviewer is its own `claude -p`
process and a **brand-new session**; nothing is ever continued, resumed or compacted.
`fresh_session` in `ralph-loop.sh` enforces this by construction, not by instructions:

- **Empty config per process.** `CLAUDE_CONFIG_DIR` points at a new empty directory, deleted when
  the process exits: no earlier sessions to `--continue`/`--resume`, no auto-memory, no
  user-level instructions. Credentials therefore come from `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` (preflight refuses to start without one).
- **Unresumable.** `--no-session-persistence` and a new `--session-id` per process; every
  session is recorded in `.ralph/logs/<run-id>/sessions.tsv` (time, ticket and phase, id).
- **No compaction.** `DISABLE_COMPACT=1` turns off automatic and manual compaction and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns off auto-memory. A session that runs out of context
  fails. Its work stays in the tree, the gate judges it, and the next attempt starts a fresh
  session from the repository and the gate output. If sessions keep running out of context and
  the ticket is rejected, the harness says the ticket is probably too large: split it.

What carries over, and nothing else:

| Between             | Through                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| Attempts of a phase | The working tree, plus the tail of the failed gate output in the prompt |
| Phases of a ticket  | The working tree and WIP checkpoint commits on the slice branch         |
| REVIEW → FIX        | The blocking findings in the FIX prompt                                 |
| Tickets             | `main`: code, tests, docs, ADRs, git history, the archived ticket       |

Prompts name the ticket file and point at `CLAUDE.md` and `docs/index.md`. They never include
earlier transcripts, review reports or completed tickets. Agents are told that `issues/done/`
is history and that `.ralph/` is not instructions.

### Completed tickets

`issues/` is the active queue and `issues/done/` the archive (contract:
[issues/README.md](../../issues/README.md)).

- Only a slice that passed REVIEW and VERIFY is archived, inside its own squashed commit, so
  `main` never shows a ticket as done without its code.
- Rejected tickets stay in `issues/` as `blocked`. A harness that dies mid-ticket leaves the
  ticket `ready-for-agent` on `main`, and its run stays `active` in `.ralph/logs`, so cleanup keeps
  the evidence. To recover, check out `main`, delete the dead run's `slice/<NN>-<slug>` branch and
  run again.
- `next_ticket` scans only `issues/`, so an archived ticket is never selected again. Blockers
  resolve across both directories by number, and a number must name exactly one file.

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
  echo it as `changeset.token`; a missing or wrong token makes the review invalid, so a reviewer
  that could not open the changeset cannot approve by reviewing other files instead.
- **Structured evidence.** Each reviewer returns JSON matching
  `skills/code-review/report.schema.json`: reviewer and axis, the commit range and token, a
  summary, every changed file (`reviewed`, or `not_relevant` with a reason), and findings with
  severity, kind (defect, security, missing test, unverified assumption, regression risk, ...),
  file and line, rule, problem, impact and correction. The Spec reviewer also gives every
  acceptance criterion (the ticket's checkboxes, numbered `AC1..ACn` in the prompt) an outcome
  with its implementation evidence and the tests that verify it; without a test it is
  `unverifiable`, not `met`.
- **Evidence gate.** `scripts/ralph-review.mjs` checks both reports against the real changeset
  and ticket. A report is **invalid** if the token or commit range differs, a changed file is
  unaccounted for, a finding names a file outside the changeset or a line outside its hunks, a
  criterion has no outcome, or a criterion is `met` without a test that exists. This is
  structural validation: it rules out reports that cannot be right, not reports that are wrong;
  the judgement stays the reviewers'. Every round writes `<slug>.review-<round>.decision.json`
  (verdict, range, token, files, criteria, errors, blockers) next to the readable report.
- **Merge policy.** `CRITICAL` and `HIGH` findings block the merge (`RALPH_REVIEW_BLOCKING`), and
  so does any acceptance criterion that is `partial`, `unmet` or `unverifiable`;
  `MEDIUM` and `LOW` are logged, not blocking. A crashed or timed-out reviewer, an error result,
  invalid JSON, a skipped axis or a tampered tree is a **failed** review, never an approval.
- **Bounded.** Up to `RALPH_MAX_REVIEW_ROUNDS` (default 3) rounds; each round except the last
  may trigger a fix. A slice still blocked, or without a valid approval, after the last round is
  rejected and quarantined like any other failure.

## Run artifacts

`scripts/ralph-artifacts.mjs` owns their lifecycle; `ralph-loop.sh` calls it when a run starts
and on exit.

| Where                     | What                                                                                           | Kept                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `.ralph/review/<run-id>/` | Changesets the reviewers read (inside the workspace)                                           | While the run is active; deleted when it succeeds; 7 days after a failed run |
| `.ralph/logs/<run-id>/`   | Agent and gate logs, review reports, decisions, a copy of every reviewed changeset, `run.json` | 30 days after the run finished                                               |
- `run.json` records the run's status (`active`, `succeeded`, `failed`) and times. A run is
  `active` until its exit trap marks it; an interrupted run that never finished stays `active` and
  is **never** cleaned automatically (remove it by hand once you are sure it is dead).
- Each run cleans expired artifacts of earlier runs when it starts, never its own. Review retries
  within a run are unaffected: every round's changeset stays until the run ends.
- Cleanup only touches directories carrying the `.ralph-managed` marker and, inside them, only
  real directories named like a run id (`YYYYMMDD-HHMMSS`); it never follows links and never
  touches source files or git history. It is idempotent.
- On exit the run's logs are scrubbed of secrets: values of `*TOKEN*`, `*API_KEY*`, `*SECRET*`,
  `*PASSWORD*` and `*CREDENTIAL*` environment variables and Anthropic key patterns become
  `[REDACTED]`.
- In the sandbox the review dir lives in the container's clone and goes with it; the archived
  changeset copies in the host's `.ralph/logs` are the evidence.

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
