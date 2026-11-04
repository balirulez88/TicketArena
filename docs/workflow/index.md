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

`pnpm run check` = `lint` → `typecheck` → `test` → `check:debt` → `test:harness`. All must pass with zero
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
  ([ADR 0010](../adr/0010-real-infrastructure-tests.md)). Each package keeps its own Vitest
  `fsModuleCache` (`<package>/node_modules/.vitest-cache`). Vitest 5's default is one cache at the
  workspace root, which every one of Turbo's parallel Vitest processes wiped at startup after a
  lockfile change; on Windows that failed intermittently with
  `ENOTEMPTY: directory not empty, rmdir '...\node_modules\.vitest-cache'`.
  `scripts/vitest-cache.test.mjs` resolves every package's config and keeps it that way.
- **Harness tests** (`test:harness`): `node:test` for the review gate and the artifact
  lifecycle, and bash scenarios that run `ralph-loop.sh` with stub agents and a stub reviewer
  (`scripts/ralph-stub-reviewer.mjs`), proving the merge policy, the evidence gate, the
  retention rules, provider-failure pause and resume, and bounded batches (all below).

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
   requires a changed test file, lint passing, and `pnpm run test --force` **failing** (Turbo's
   cache bypassed, so no replayed result stands in for running the new tests). Then
   `scripts/ralph-red.mjs` runs exactly the changed test files through their package's own Vitest
   and accepts RED only if each one belongs to a workspace package with a `test` script, executes
   at least one test, and at least one test fails (on an assertion, or on an error inside a test
   such as calling a function that does not exist yet). The evidence directory is emptied first,
   so an earlier attempt's report never counts. A test that passes before any implementation, one
   no package discovers (e.g. in a package that has no scaffolding yet), one that fails to load,
   or one that is all skipped proves nothing and is rejected. A brand-new package therefore needs
   its scaffolding merged first, as a separately reviewed change.
3. **GREEN:** the agent implements until the full gate passes. Gate output from a failed attempt
   is fed into the next one, up to `RALPH_MAX_ATTEMPTS`.
4. **REFACTOR + DOCS:** the agent runs the code-review/refactor pass and `update-docs`. The gate
   must stay green. If it does not, the refactor is discarded and the green state kept.
5. **REVIEW:** two independent reviewers judge the whole changeset (see below). Blocking
   findings go back to the agent (**FIX**, gated like GREEN), then a fresh review round.
6. **DEBT:** the approved round's deferred findings are recorded in the
   [technical debt register](#technical-debt-register) and checkpointed.
7. **VERIFY:** the full gate runs once more on the approved tree, register check included.
8. Squash into **one** Conventional Commit. In the same commit the ticket is marked `done`,
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
- **Unresumable.** `--no-session-persistence` and a new `--session-id` per process.
- **Every session logged exactly once.** Each process writes its own record in
  `.ralph/logs/<run-id>/sessions/` before it launches and replaces it atomically when it ends, so
  parallel reviewers never write to the same file. When the run ends, the records are merged into
  `sessions.tsv` (started, label, session, status, exit code, finished). The status is `ok`,
  `failed` (including launch failures, exit 127), `timed-out` or `interrupted`. A run killed
  outright leaves its unfinished records as `running` in `sessions/`.
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
  run again. (In the sandbox the clone dies with the container, so a rerun simply starts over.)
- A ticket **paused** by a provider failure is neither rejected nor blocked: it stays
  `ready-for-agent` and the next run resumes it (see
  [Provider failures](#provider-failures-pause-and-resume)).
- A ticket is processed once: `process_ticket` refuses a ticket whose file is in `issues/done/`.
- `next_ticket` scans only `issues/`, so an archived ticket is never selected again. Blockers
  resolve across both directories by number, and a number must name exactly one file.

### Provider failures: pause and resume

A Claude session can fail because the provider refused or dropped it, not because the work is
wrong. Charging that to the ticket would reject good work; the reverse mistake (calling a real
failure the provider's) would grant free attempts. So:

- **Classification** (`scripts/ralph-provider.mjs`, unit-tested) looks only at a session that
  failed (non-zero exit or a JSON `is_error` result, never a timeout) and only at the CLI's own
  error formats in the last lines of its output: `usage-limit` (`Claude AI usage limit reached`,
  `… limit reached ∙ resets …`, credit exhausted), `auth` (401/403, invalid key, expired OAuth
  token) or `transient` (`API Error: 429/5xx`, `overloaded_error`, connection errors). Anything
  else, including an agent quoting those phrases, is `none`: a genuine failure, judged exactly as
  before (fails closed).
- **Transient**: retried in a **new fresh session** after a doubling backoff
  (`RALPH_PROVIDER_RETRIES`, default 2; `RALPH_PROVIDER_BACKOFF`, default 60 s). The retry does
  not consume the implementation attempt. A reviewer's cut-off output is kept as
  `<slug>.review-<round>.<axis>.provider-<n>.json` and never shown to the gate.
- **Usage limit, refused credentials, or a provider still down after the retries**: the run
  **pauses** (exit 75, run status `paused`). Nothing is rejected, blocked or counted. The work in
  progress is committed on `ralph/paused/<NN>-<slug>` directly on top of the last gated
  checkpoint (pushed to the host from the sandbox), and `.ralph/state/<slug>.pause` records the
  phase, attempt and review round, next to the gate feedback and blocking findings that phase was
  given. An interrupted review round never reaches the gate, so it can never approve.
- **Resume** (manual: run the same command again). The harness recreates the slice branch at the
  gated checkpoint with the interrupted phase's work uncommitted on top, then continues at that
  phase and attempt. Phases already passed are not rerun; every later gate (review, debt, VERIFY)
  runs as normal. An interrupted review round is redone from scratch: new changeset token, both
  axes, no earlier report reused. It **fails closed**: if the parked ref is not exactly what the
  pause recorded, does not sit on the recorded checkpoint, or `main` has moved since the pause,
  it refuses and names the state file; deleting that file restarts the ticket from scratch.
- When the ticket merges or is rejected, its pause state and parked ref are deleted.

Scenarios: `scripts/ralph-resume.test.sh` (usage limit in GREEN, review and review fix; bounded
transient retries; genuine failures still counted; stale or forged pauses refused; the sandbox
clone round-trip). Run against the harness from before this change (`RALPH_UNDER_TEST=<path>`),
they fail: it rejected and blocked the ticket instead.

### Bounded batches (`--max-tickets`)

`pnpm sandbox --max-tickets N` (`scripts/ralph-batch.mjs`) runs on the **host**, because the
sandbox has no GitHub credentials. `--once`, `--ticket` and a bare run behave as before.

1. Before each ticket, the base branch must be on GitHub and **CI green on that exact commit**
   (`scripts/ralph-ci.sh`: only a completed, successful run of `ci.yml` counts).
2. The next eligible ticket is chosen by `ralph-loop.sh`'s own `next_ticket` and runs in its own
   sandbox (`--ticket NN`), so every gate above applies.
3. `main` is pushed to GitHub and the batch waits for CI on the merge. It stops at N tickets
   merged and verified.

State lives in `.ralph/batch/state.json`, written atomically after every step. The **repository
is the source of truth** for merges: a ticket is merged only if `main` has both its archived file
and its `Merge slice/<slug>:` commit. A rerun therefore resumes at the right checkpoint (run, push,
CI) and never runs a merged ticket twice. The limit is stored with the batch; a conflicting
`--max-tickets` is refused. `.ralph/batch/lock` (an atomic `mkdir`) admits one batch at a time,
and `pnpm sandbox` refuses to run beside one. A lock left by a killed batch is never taken over
automatically: the message says so, and a human removes it after checking that no batch or
container is still running.

| Stop                                                                                    | Meaning                                         | Exit |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- | ---- |
| `batch-limit`, `no-eligible-ticket`                                                     | finished                                        | 0    |
| `unresolved-dependency`                                                                 | finished; ready tickets wait on unfinished ones | 2    |
| `paused`                                                                                | provider failure; rerun to resume               | 75   |
| `ambiguous-merge`, `runner-failed`, `push-failed`, `ci-unverified`, `base-not-verified` | blocking until a rerun can verify it            | 1    |
| `rejected`, `ci-failed`                                                                 | final; resolve it, then `--new` starts a batch  | 1    |

`node scripts/ralph-batch.mjs --status` prints the current batch. Nothing is ever deployed.
Scenarios: `scripts/ralph-batch.test.mjs` (limit, CI gating, rejection, pause and resume with
the stored limit, a batch killed right after a merge, ambiguous runner results, the lock) and
`scripts/ralph-ci.test.mjs`.

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
  workspace (the reviewers' file access is confined to it), with a copy in the run logs. Every
  hunk line is prefixed with its OLD and NEW source line numbers (`    .    27 | +code`). Real
  reviewers had cited positions within the diff file instead (line 69 for source line 27), which
  the gate rejects. The file and hunk headers are unchanged, and the gate validates against
  them as strictly as before.
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
- **Invalid report, asked once more.** An invalid report says nothing about the code, so the
  harness does not spend a fix round on it: each reviewer whose report is invalid is asked again
  **once** within the same round, in a fresh session, with the gate's reasons
  (`<slug>.review-<round>.<axis>.rejected.txt`; the first report stays as `.invalid.json`). The
  gate then judges the pair exactly as before; a second invalid report fails the round. Without
  this, the other axis's valid blocking findings would wait a round unfixed.
- **Bounded.** Up to `RALPH_MAX_REVIEW_ROUNDS` (default 3) rounds; each round except the last
  may trigger a fix. A slice still blocked, or without a valid approval, after the last round is
  rejected and quarantined like any other failure.

## Technical debt register

[`docs/technical-debt.md`](../technical-debt.md) is the version-controlled record of review
findings that were deferred instead of fixed (rules in the file itself). `scripts/ralph-debt.mjs`
owns its format; Ralph uses it at four points, all inside existing stages:

| Stage           | What happens                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every agent run | The prompt points at the register: entries whose `Target` names the ticket are part of it; a fix sets `RESOLVED` with `Resolution` and a `Verification` test                                                                                                                                                                                                                                       |
| REVIEW          | Reviewers read entries overlapping the changed files, cite a matching entry in the finding's `debt` field, rate a worsened entry by its real impact (may block), and treat an unproven resolution as `HIGH`. The gate rejects as invalid evidence a `debt` id the register lacks, and a non-blocking finding citing a `RESOLVED`, escalated entry (recording it would reopen that entry as `OPEN`) |
| DEBT (approved) | `record` adds the final round's `MEDIUM`/`LOW` findings as `OPEN` entries at their original severity, with the report path as evidence                                                                                                                                                                                                                                                             |
| VERIFY, CI      | `check:debt` (in `run_gate` and `pnpm run check`) rejects an invalid or unformatted register                                                                                                                                                                                                                                                                                                       |

Guarantees, each covered by `scripts/ralph-debt.test.mjs` or `scripts/ralph-loop.test.sh`:

- **Gates unchanged.** Only an approved round is recorded, after the review and before VERIFY; a
  blocking finding is refused, never recorded. The register change rides in the slice's
  squashed commit, so it passes the same gate, review and CI as the code.
- **No duplicates.** A finding updates an existing entry when it names it in `debt`, when its
  fingerprint (file and normalized title) is already on an entry, or when the other axis reported
  the same file and line in that round. Earlier review rounds are never recorded: their findings
  were fixed or reappear in the final round. History lines are keyed by ticket, round, axis and
  run, so re-processing a round is a no-op.
- **Evidence for resolutions.** `check` refuses `RESOLVED` without a `Resolution` and a
  `Verification` naming an existing test file; reviewers judge whether the test proves it; on
  merge, `record` adds a `resolution verified` history line. A resolved entry reported again is
  reopened.
- **Nothing disappears.** `record` compares with the base branch's register and rejects the slice
  if an entry was removed. An escalated entry cannot stay `OPEN` or `ACCEPTED_RISK`.

## Run artifacts

`scripts/ralph-artifacts.mjs` owns their lifecycle; `ralph-loop.sh` calls it when a run starts
and on exit.

| Where                     | What                                                                                           | Kept                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `.ralph/review/<run-id>/` | Changesets the reviewers read (inside the workspace)                                           | While the run is active; deleted when it succeeds; 7 days after a failed or paused run |
| `.ralph/logs/<run-id>/`   | Agent and gate logs, review reports, decisions, a copy of every reviewed changeset, `run.json` | 30 days after the run finished                                                         |
- `run.json` records the run's status (`active`, `succeeded`, `failed`, `paused`) and times. A run is
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
