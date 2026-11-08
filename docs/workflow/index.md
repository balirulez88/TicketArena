# Agent Workflow & Quality Gate

[← System map](../index.md)

## Pipeline

| Step | Skill / tool                                             | Output                              |
| ---- | -------------------------------------------------------- | ----------------------------------- |
| 1    | `/grill-me` (→ `grilling`)                               | Shared understanding, decisions     |
| 2    | `/to-spec`                                               | `docs/specs/<feature>.md`           |
| 3    | `/to-tickets`                                            | `issues/<NN>-<slug>.md`             |
| 4    | `ralph-loop.sh` (in sandbox); opt-in `RALPH_DRIVER=lead` | One green, atomic commit per ticket |
| 5    | `/update-docs` (inside step 4)                           | Updated `/docs` maps                |
| 6    | `/code-review` (inside step 4)                           | Standards + Spec reports, per slice |

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

For each ticket whose `**Status:**` is `ready-for-agent`, whose blockers are all `done` and that
the [debt gate](#debt-gate) clears (`waiting` and `needs-triage` tickets are skipped until their
debt is resolved or triaged):

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
  checkpoint (in the sandbox it leaves in the run's bundle, and the host adopts it only after
  validating it: [trust boundary](#trust-boundary-adr-0014)), and `.ralph/state/<slug>.pause` records the
  phase, attempt and review round, next to the gate feedback and blocking findings that phase was
  given. An interrupted review round never reaches the gate, so it can never approve. Refused
  credentials pause too, deliberately: like a usage limit they say nothing about the ticket and
  cannot clear up within the run, and rejecting good work over an expired token would be wrong.
  If the work cannot be parked (a git step fails), the run fails (exit 1) without writing resume
  state and leaves the work on the slice branch for a human; it is never reported as paused.
- **Resume** (manual: run the same command again). The harness recreates the slice branch at the
  gated checkpoint with the interrupted phase's work uncommitted on top, then continues at that
  phase and attempt. Phases already passed are not rerun; every later gate (review, debt, VERIFY)
  runs as normal. An interrupted review round is redone from scratch: new changeset token, both
  axes, no earlier report reused. It **fails closed**: if the parked ref is not exactly what the
  pause recorded, does not sit on the recorded checkpoint, or `main` has moved since the pause,
  it refuses and names the state file; deleting that file restarts the ticket from scratch.
- When the ticket merges or is rejected, its pause state and parked ref are deleted.

Scenarios: `scripts/ralph-resume.test.sh` (usage limit in every agent phase, review and review
fix, each resumed through review and VERIFY; refused credentials; bounded transient retries;
genuine failures still counted; a pause that cannot park; stale or forged pauses refused; the
sandbox clone round-trip). Run against the harness from before this change (`RALPH_UNDER_TEST=<path>`),
they fail: it rejected and blocked the ticket instead.

### Bounded batches (`--max-tickets`)

`pnpm sandbox --max-tickets N` (`scripts/ralph-batch.mjs`) runs on the **host**, because the
sandbox has no GitHub credentials. `--once`, `--ticket` and a bare run behave as before.

1. Before each ticket, the base branch must be on GitHub and **CI green on that exact commit**
   (`scripts/ralph-ci.sh`: only a completed, successful run of `ci.yml` counts). This includes
   the first ticket, deliberately: a batch never builds on a base that CI has not passed, whoever
   moved it.
2. The next eligible ticket is chosen by `ralph-loop.sh`'s own `next_ticket` and runs in its own
   sandbox (`--ticket NN`), so every gate above applies.
3. `main` is pushed to GitHub and the batch waits for CI on the merge. It stops at N tickets
   merged and verified.

State lives in `.ralph/batch/state.json`, written atomically after every step. It is host-only:
the container never sees it ([trust boundary](#trust-boundary-adr-0014)). The **repository
is the source of truth** for merges: a ticket is merged only if `main` has both its archived file
and its `Merge slice/<slug>:` commit, and only `scripts/ralph-accept.mjs` puts those there after
validating the run. A rerun therefore resumes at the right checkpoint (run, push,
CI) and never runs a merged ticket twice. The limit is stored with the batch; a conflicting
`--max-tickets` is refused. Every step first rechecks that `main` is checked out and clean
(`checkout-changed` otherwise), so what is pushed is exactly what was accepted. A run that leaves
a new `rejected/<slug>-*` branch is a rejection. A run whose output the host refused (sandbox
exit 3) ends the batch with `untrusted-result`; it is never retried automatically.
`.ralph/batch/lock` (an atomic `mkdir`)
admits one batch at a time, and `pnpm sandbox` refuses (best effort) to run beside one. A lock left by a killed batch is never taken over
automatically: the message says so, and a human removes it after checking that no batch or
container is still running.

| Stop                                                                                                        | Meaning                                                                                           | Exit |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---- |
| `batch-limit`, `no-eligible-ticket`                                                                         | finished                                                                                          | 0    |
| `unresolved-dependency`                                                                                     | finished; ready tickets wait on unfinished ones                                                   | 2    |
| `needs-triage`                                                                                              | no cleared ticket left; one depends on untriaged or unowned debt; triage it on `main`, then rerun | 4    |
| `paused`                                                                                                    | provider failure; rerun to resume                                                                 | 75   |
| `ambiguous-merge`, `runner-failed`, `push-failed`, `ci-unverified`, `base-not-verified`, `checkout-changed` | blocking until a rerun can verify it                                                              | 1    |
| `rejected`, `ci-failed`, `untrusted-result`                                                                 | final; resolve it, then `--new` starts a batch                                                    | 1    |

`node scripts/ralph-batch.mjs --status` prints the current batch. Nothing is ever deployed.
Scenarios: `scripts/ralph-batch.test.mjs` (limit, CI gating, rejection on the base or a side
branch, pause and resume with the stored limit, a batch killed right after a merge, half-merged
and ambiguous runner results, the lock, and the `sandbox.sh` / `ralph-loop.sh` entry points) and
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
- **The host's review decides** ([ADR 0015](../adr/0015-review-and-verification-isolation.md)).
  In the sandbox, these rounds run in the agent's container and only drive its fix loop. Before a
  slice reaches `main`, the host runs one more round of its own (`scripts/ralph-host-review.mjs`):
  the same prompts (`scripts/ralph-review-prompt.mjs`), schema and gate, with a changeset and token
  the host made, each reviewer a fresh session in its own container (read-only root and input, read-only tools) that sees exactly the
  candidate commit and has no output mount. Its reports and decision are in
  `.ralph/host-review/<run>/<slug>/`. An invalid report is asked for once more; both axes must
  approve. The host records that round's deferred findings in the register in its own commit.

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
  reopened. The host's importer judges that evidence in the candidate commit's own Git tree
  (a regular file at exactly that path, read with `git ls-tree`, nothing executed), so a slice
  may resolve an entry with a test it adds, and a file only the host has never counts.
- **Nothing disappears.** `record` compares with the base branch's register and rejects the slice
  if an entry was removed. An escalated entry cannot stay `OPEN` or `ACCEPTED_RISK`.

### Debt gate

[ADR 0016](../adr/0016-risk-based-debt-gate.md). Each entry carries a `Risk` class, a `Triage`
line, an owner (`Target: ticket NN`) and the tickets it `Blocks`; humans set them in reviewed
commits. `node scripts/ralph-debt.mjs gate` prints every unfinished ticket's verdict:

| Verdict        | Cause                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs-triage` | an unresolved `MEDIUM`+ entry is untriaged or unowned (all tickets); an untriaged `LOW` found by a ticket this one builds on, or owned by it, or found outside any ticket's review (all tickets); an entry back in triage that still `Blocks` the ticket |
| `waiting`      | a triaged unresolved entry lists the ticket in `Blocks`                                                                                                                                                                                                  |
| `clear`        | neither                                                                                                                                                                                                                                                  |
- **Selection and batch.** `next_ticket` picks the first cleared ticket, so independent work
  continues; the batch stops `needs-triage` (exit 4, resumable) once no cleared ticket is left
  and one needs triage, and re-checks a paused ticket before resuming it. An invalid register
  clears nothing.
- **Importer.** The host refuses (exit 3) a ticket the base's gate does not clear, and a slice
  whose register changes anything but resolving entries and the recorder's own additions
  (`slice` rules: severity, risk, triage, target, blocks, acceptance and history are fixed), or
  leaves an entry the ticket owns unresolved. `debt_slice_check` in `run_gate` applies the same
  rules inside the loop, early.
- **Maintainers.** CI runs `ralph-debt.mjs audit` against the base: every governed field a
  commit changes needs a new history line, and no entry or history line disappears.
- **Recorder.** New entries are `UNTRIAGED`/`pending` (a `security` finding is `SECURITY`); the
  history suggests a class. A higher-severity sighting sends the entry back to triage.

Scenarios: `scripts/ralph-debt.test.mjs`, `scripts/ralph-accept.test.mjs` (the debt gate),
`scripts/ralph-batch.test.mjs` (needs-triage, resume, independent and blocked tickets).

## Lead driver (opt-in, [ADR 0017](../adr/0017-opt-in-lead-driver.md))

`RALPH_DRIVER=lead pnpm sandbox --ticket NN` runs one ticket with a single Lead session instead of
Ralph's phases. Unset or `ralph` runs `ralph-loop.sh`, unchanged; any other value, and the lead
without `--ticket`, exit 2 before a container exists (`scripts/ralph-driver.sh`). Discovery
(`/grill-me`, `/to-spec`, `/to-tickets`) is untouched: the lead consumes a `ready-for-agent` ticket.

| Step   | Who                                        | What                                                                                                                                                              |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work   | one Lead session (`scripts/ralph-lead.sh`) | keeps its context for the ticket; delegates all editing to `ticketarena-implementer`; may call the read-only `ticketarena-reviewer` once (advisory, no loop)      |
| Judge  | the driver, after the session              | git intact (slice branch on the base, base unmoved); **RED re-proved** (base + only the candidate's test files through `verify_red`); `run_gate` incl. debt rules |
| Land   | `finalize_slice` / `reject_slice`          | the same one-commit squash, archive and merge, or quarantine branch and `blocked` ticket                                                                          |
| Accept | the host, `ralph-accept.mjs`               | unchanged: path rules, debt gate, hardened re-gate, isolated Standards and Spec review of the exact commit                                                        |
- **One session, no retry, no fallback.** A failed, timed-out, provider-limited or interrupted
  session is never repeated, never handed to Ralph and never blocks the ticket. The work is saved
  as `logs/<slug>.lead-work.patch` (imported by the host), `main` is untouched, exit 1. The
  entrypoint forwards `SIGTERM`/`SIGINT` to the driver so `docker stop` ends this way, not in a
  kill.
- **Handoff.** The Lead runs its subagents in the foreground and ends its session only after it
  wrote `.ralph/lead/checklist.md` and `.ralph/lead/changeset.md` (pilot of ticket 56: it ended its
  turn while the implementer ran in the background). The driver copies `.ralph/lead/` to
  `logs/<slug>.lead-handoff/` as soon as the session ends. A session that ends without both files
  is treated as unfinished: nothing is judged, merged or blocked, the work is saved as
  `lead-work.patch`, exit 1.
- **Tests and the host.** `pnpm test:harness` (`scripts/ralph-lead.test.sh`, plus the importer
  scenarios in `scripts/ralph-accept.test.mjs`) and `pnpm test:sandbox` (real Docker, scenarios
  `lead-*`).
- **Usage.** The Lead's JSON result is kept as `<slug>.lead.json`; `node scripts/ralph-usage.mjs
  .ralph/logs/<run> .ralph/host-review/<run>` totals tokens and the CLI's reported cost. The dollar figure is
  API-price arithmetic, not subscription usage: compare tokens and read the plan's own meter.
  Tokens are summed from `modelUsage`, which includes subagent turns; the result's top-level
  `usage` counts only the session's own (measured on a one-subagent call).
- `RALPH_LEAD_CMD`, `RALPH_LEAD_TIMEOUT` (default 7200 s) and `RALPH_LEAD_MAX_BUDGET_USD` (optional
  cap) tune a run.

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

`Dockerfile` defines a Node 24 + pnpm + git + Claude Code image. It also contains Postgres 17,
Redis 7 and nats-server (checksum-verified), which the entrypoint starts before the loop, so every
slice is judged on real infrastructure. Host-native `node_modules` (e.g. Windows binaries) never
mix with Linux ones.

### Trust boundary ([ADR 0014](../adr/0014-sandbox-trust-boundary.md))

The agent runs with permission prompts disabled, so the container is treated as hostile.
`scripts/sandbox.sh` requires a clean `main` checkout and builds the image. Each run gets
`.ralph/sandbox/<run>/` with:

- `in/` (mounted **read-only** at `/ralph-in`): `repo.bundle` (`main` plus every
  `ralph/paused/*` branch) and `state/`, a copy of the host's resume state;
- `out/` (`/ralph-out`): logs as they are written, then `state/` and `result.bundle` at exit.

Nothing else is mounted. That excludes the host repository, its `.git`, `.ralph/batch` and
`.ralph/state`, the Docker socket, and GitHub credentials. The container runs with
`--cap-drop ALL` and `no-new-privileges`. Inside it, the entrypoint clones the bundle into a
private staging bare repository and a workspace, and Ralph pushes to that staging repository
(`RALPH_PUSH_REMOTE=origin`). At exit, the staging repository's branches are bundled into
`result.bundle`, whatever the outcome.

`scripts/ralph-accept.mjs` then decides on the host. It is the only code that changes the host
repository from a run, and everything in `out/` is data to it:

- The bundle is fetched by the host's own Git into `refs/ralph/incoming/<run>/`. Fetching from
  a bundle does not apply `fetch.fsckObjects`, so every object the bundle adds is first checked
  with `index-pack --strict --fsck-objects` in a scratch repository that borrows the host's
  objects. A malformed object is refused before it reaches the host's object store, where it
  would outlive the refusal and fail every later check. No Git command ever runs inside a
  repository the container wrote, so no hook or config of the container's can execute on the
  host.
- `main` may gain only Ralph's own shapes, checked against the base the run started from:
  - a **slice merge**: one squashed commit on the base, under `Merge slice/<slug>: <title>` with
    an identical tree, Ralph's commit subject, and a ticket that was `ready-for-agent` with all
    blockers `done` (and is the `--ticket` the run was given). The only issue-file change is the
    archive to `issues/done/`: `done`, `Completed`, ticked checkboxes, nothing else.
  - a **blocked-status commit** that changes only that ticket's status line. Its quarantine
    branch `rejected/<slug>-<run-id>` is imported as a new branch. Its tree is unvalidated:
    inspect it with `git log -p` or `git show`, never by checking it out.
- **Protected paths** may not change through a run: `ralph-loop.sh`, `scripts/`, `Dockerfile`,
  `.dockerignore`, `.github/`, `skills/`, `infra/`, `docs/workflow/`, `packages/test-infra/`,
  `tsconfig.base.json`, `turbo.json`, `.nvmrc`; and in any directory `.gitignore` (the host-only
  rule reads it), what runs or decides what runs in the verifier's trusted processes
  (`vite(st).config.*`, `vitest.workspace.*`, `postcss.config.*`, `tailwind.config.*`,
  `prisma.config.*`, `tsconfig*.json`, `.editorconfig`; ADR 0015),
  `biome.json(c)`, `turbo.json(c)`, `.npmrc`, `pnpm-workspace.yaml` (its `scriptShell` changes
  what a package's scripts run), `.pnpmfile.*`, `package.yaml`, `package.json5`, `binding.gyp`,
  Docker Compose files (`compose*.y(a)ml`, `docker-compose*.y(a)ml`), `CLAUDE.md`,
  `CLAUDE.local.md`, `.mcp.json`, and anything under `.claude/`, `.vscode/` or `.idea/`. In the
  root `package.json` only the dependency maps may change. In any other `package.json`, the gate
  scripts (`lint`, `typecheck`, `test`, `check`, `check:debt`, `test:harness`, `db:generate`, and
  their `pre`/`post` scripts) are fixed and the package may not be deleted; a new package's gate
  scripts other than `test` must run a command a package of the base runs under that name; its dependencies and other
  scripts may change, and new packages may be added. No package, new or old, may gain an install script (`preinstall`, `install`,
  `postinstall`, `prepare` and the like), and a manifest that is not a JSON object is refused.
  Prisma `generator` blocks may not change (a generator names a program `prisma generate` runs).
- **The toolchain's locked dependencies** (ADR 0015): in `pnpm-lock.yaml`, an entry the base
  locks may be dropped but not redefined; Vitest, Vite, TypeScript, Turbo, Biome, Prisma, esbuild,
  the CSS tooling Vite loads, and every dependency of the root manifest and of the test
  infrastructure must resolve to entries the base locks (a `link:` only where the base has the
  same link); packages allowed to run build scripts may
  not gain versions; pnpm's own entry, the settings and overrides are fixed; YAML aliases, tags,
  anchors, merge keys and duplicate keys are refused. Ordinary dependencies may change.
- **Host-only paths** may not be written: `.ralph/`, `node_modules/`, `.pnpm-store/`, `.turbo/`,
  `.env` files (examples aside), and anything the host's own ignore rules match. A fast-forward
  would overwrite such ignored files without a trace, planting state, credentials or
  executables the host then trusts. Neither may
  `.gitattributes` and `.gitmodules` change anywhere, and no symlinks or submodules may appear.
  The scripts the batch runs on the host, and the gate that judges the next slice, therefore
  change only through a human-reviewed commit.
- Every rule compares **folded** path names: Unicode NFC, lower case, trailing dots and spaces
  dropped per component. That is how Windows and macOS resolve them, so `Scripts/x.sh` or
  `scripts./x.sh` is `scripts/x.sh`; ignorable code points are dropped and case is fully folded
  (`ſ` is `s`), as HFS+ and APFS do. Names Windows would resolve elsewhere (8.3 short names such
  as `SCRIPT~1`, stream syntax, device names such as `aux.ts`, reserved characters) and names with
  control characters are refused, as is a tree in which two paths fold to the same name.
- The **full gate runs again** on the merged tree before `main` moves, with no agent and no key
  (`sandbox.sh --verify <sha>`, `scripts/ralph-verify.mjs`), in staged disposable containers
  sharing one workspace volume. Each drops all capabilities, has memory, CPU and process limits
  and a timeout, and mounts nothing of the host but the read-only input. **prepare** (network on)
  checks the register before anything is installed, installs, refuses any package outside the
  toolchain whose bin shadows a command the gate trusts (`scripts/ralph-bins.mjs`), and
  generates; **tools** (no
  network) runs the register check, lint, typecheck and harness tests, none of which execute the
  slice's code; **test** runs each workspace package's `test` script in its own container with no
  network, a read-only root file system and a read-only workspace, against its own services, and
  only if Yama restricts `ptrace`. The verdict is the containers' exit status, nothing else.
- The **host's own review** then judges the exact slice commit (see Independent review). If it
  does not approve, none of the run lands: the host blocks the ticket in its own commit and keeps
  the work on `rejected/<slug>-<run>`. A reviewer cut off by the provider leaves the host
  unchanged.
- A **pause** is adopted only if it is exactly what `pause_ticket` writes. It must belong to the
  run's ticket and to parked work that is in the bundle on the base, with `paused^ = gated` and
  attempt and round within limits, and the parked work must obey the path rules. The host
  rewrites it in canonical form into `.ralph/state/`. Resume state the host handed in must come
  back unchanged.
- Logs are copied into `.ralph/logs/<run-id>/` as plain files (links and special files dropped,
  files over 64 MiB and existing files kept), redacted with the host's secrets, and expired by
  the host's retention. The container's raw copy in the run directory is then deleted.

The host moves `main` by fast-forward only, after rechecking that the checkout is still clean
and on the same base. Exit codes: `0` accepted, `75` paused, `1` rejected or failed, `3`
**refused as untrusted**. On a refusal, the host is unchanged, and the result stays in
`refs/ralph/incoming/<run>/` and `.ralph/sandbox/<run>/` (with `verdict.json`) for a human.
Delete both once inspected.

Scenarios: `scripts/ralph-accept.test.mjs` covers the four attack paths (forged merges and
archives; Git config, hooks and links; harness, CI and gate definitions; forged pause state) as
well as genuine merges, rejections, pause and resume, and interrupted runs.
`pnpm test:sandbox` (Docker; also a CI job) proves the boundary through the real sandbox. Inside
the container, it checks that the host repository is absent, the input is read-only, there is no
Docker socket, and only the two run directories are mounted. It also runs a merge (re-gated and
reviewed by the host), a rejection, a usage-limit pause and its resume, a malicious agent's forged
merge and forged resume state (refused, with the host's refs, Git config, hooks and scripts
byte-for-byte unchanged), a slice linking a package whose bin is named `node` (refused by the bin check before any script
runs), a malicious agent whose tests attack the host's gate (they cannot
rewrite another test, the runner or the dependencies, reach the network or the host, and the gate
fails), a slice the agent's reviewers approve but the host's isolated reviewers block (not merged;
the reviewer containers see exactly the candidate, read-only, with no output mount), and a dirty
host checkout (refused before any container starts).

The threat model and the limitations that remain (prompt injection of the reviewers, shared state
within one package's test run, network during install, hoisted modules, merged code running on
developer machines and in CI) are in [ADR 0015](../adr/0015-review-and-verification-isolation.md).

`pnpm sandbox --verify [commit]` runs just the gate inside the sandbox (no agent, no API key):
use it after changing the image. The agent runs with permission prompts disabled **only** inside
the container (`RALPH_SANDBOX=1`); the script refuses to do so elsewhere unless explicitly
overridden.
