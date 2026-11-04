# 0015: Isolated reviewers and hardened verification

- **Status:** Accepted
- **Date:** 2026-11-04
- **Extends:** [0014](0014-sandbox-trust-boundary.md)

## Context

ADR 0014 keeps the agent away from the host. Two decisions still rested on things the agent could
reach (TD-058, HIGH):

- **The reviews.** The Standards and Spec reviewers ran inside the agent's container, as the
  agent's Unix user, on its file system. A malicious agent could rewrite their reports or the
  review gate's decision before the loop read them. The host checked the merge's shape and paths
  and re-ran the deterministic gate, but it never re-derived the reviewers' approval.
- **The re-gate.** The host's agent-free gate executed the slice's own code: its tests, its
  `vitest.config` and `tsconfig.json`, the dependencies its lockfile resolves. That code could
  narrow what the gate covers, or tamper with the runner, the tooling and later gate steps from
  inside its own checkout. Running tests outside the agent's session does not make them
  trustworthy.

Autonomous production batches stay blocked until both are enforced by the host, not by
convention.

## Threat model

- **Adversary:** the development agent, assumed fully malicious and capable. It controls
  everything in its container: the code and tests of the slice, its Git history, its logs,
  reports and resume data. It may plant processes, files and prompt text.
- **Trusted:** the host, its repository and Git, the harness on the base branch, Docker, the
  kernel, the sandbox image built from the base, and the model provider.
- **Assets:** the base branch, the host's batch and resume state, its credentials, and the two
  decisions that let a slice merge: the gate's verdict and the reviewers' approval.
- **Goal:** nothing the agent produces can make the host merge a slice unless the host's own
  gate passed on it and the host's own reviewers approved exactly it.

## Decision

The host decides both, with nothing taken from the agent's container.

### Reviews: the host's own, in isolated containers

`scripts/ralph-host-review.mjs`, called by `scripts/ralph-accept.mjs` for every merged slice after
the path rules and the gate passed:

- The host builds the changeset (`base...slice`, with its own Git), a fresh random token, the two
  prompts (`scripts/ralph-review-prompt.mjs`, the one source the loop uses as well) and the
  schema, from its own copy of the harness.
- Each reviewer is a fresh session in its own disposable container (`sandbox-entrypoint.sh
  --review`). It receives a bundle with one ref, the candidate slice commit, checks it out and
  verifies `HEAD`. Its tools only read; its workspace has its write permissions removed (it owns
  that tmpfs, so this guards against accidents, not against the reviewer), the root file system
  and its input are read-only, it has no output mount, no host path, no Docker socket and no capabilities, and it is killed at its
  timeout. Its report is its standard output, read by the host through Docker.
- The host judges the two reports with the review gate (`scripts/ralph-review.mjs`) against the
  candidate's real changeset, commit range, token, ticket and debt register. Test references
  must exist in the candidate's tree. An invalid report is asked for once more with the gate's
  reasons, in a new container, as in the loop. Both axes must approve.
- Not approved: nothing of the run reaches `main`. The host blocks the ticket in its own commit
  and keeps the candidate on `rejected/<slug>-<run>`, so the batch stops as `rejected`. A
  reviewer the provider cut off leaves the host untouched (`review-unavailable`); the batch stops
  resumably.
- Approved: the host records the review's deferred findings in the debt register, in its own
  commit after the merge. No entry of the base may be lost.

The loop's own review rounds stay as they were. They drive the fix loop, cheaply and early. They
are no longer evidence for anything the host decides.

### Verification: hardened, staged, offline containers

`scripts/ralph-verify.mjs` (`scripts/sandbox.sh --verify`) replaces the single re-gate container.
Each stage is a disposable container of the sandbox image with all capabilities dropped,
`no-new-privileges`, memory, CPU and process limits and a host-enforced timeout. The only host
mount is the read-only input; the stages share one Docker volume holding the workspace.

1. **prepare** (network on, to fetch packages): clone the candidate, check the register, install
   the locked dependencies, check the linked bins (`scripts/ralph-bins.mjs`, from the image),
   generate the database client.
2. **tools** (no network): register check, lint, typecheck, harness tests.
3. **test** (no network, read-only root file system, read-only workspace): one container per
   workspace package that has a `test` script, plus the root `test` script when it is not
   `turbo run test`. Services run on the container's loopback. The container refuses to start
   unless Yama restricts `ptrace` (`ptrace_scope` ≥ 1).

The verdict is each container's exit status as Docker reports it. No file, log or output of a
stage is read.

Only the test stage executes the slice's code, and there it can write nothing that another
package's run, a later stage or the host reads. Everything else that runs, before or during the
tests, in a role the verdict depends on, is fixed by the base, enforced by the importer's path
rules:

- per-package Vitest and Vite configuration (`vite(st).config.*`, `vitest.workspace.*`), which
  runs in the Vitest main process that reports the verdict, and the PostCSS and Tailwind
  configuration Vite loads;
- the shared test infrastructure (`packages/test-infra/`), whose global setup runs there too;
- `tsconfig*.json` and `.editorconfig` (what typecheck and lint cover);
- `prisma.config.*`, the Prisma `generator` blocks and every package's `db:generate` scripts;
- a new package's gate scripts other than `test` (`lint`, `typecheck`, `db:generate`, their
  `pre`/`post` scripts): each must run a command some package of the base already runs under
  that name, since the install and tools stages run them in a workspace later stages trust;
- the toolchain's locked dependency closure. In `pnpm-lock.yaml`, an entry the base locks may be
  dropped but never redefined. Toolchain packages (Vitest, Vite, TypeScript, Turbo, Biome,
  Prisma, esbuild, the CSS tooling Vite loads, every dependency of the root manifest and of the
  test infrastructure) must resolve to entries the base locks, and resolve to a `link:`
  directory only where the base links that name to the same directory (a link, `workspace:`
  included, would put a directory of the slice in the toolchain's place). Packages allowed to run build
  scripts may not gain new versions. pnpm's own locked entry, the settings and overrides may not
  change. YAML aliases, tags, anchors, merge keys and duplicate keys are refused, so pnpm's
  parser cannot read the file differently from the importer's.

- the commands the gate runs by name. pnpm links each project's direct dependencies' bins first on
  its PATH, and its shims run a `node` found there in place of node. A lockfile does not record
  bin names, so after the install and before any script, the image's bin check
  (`scripts/ralph-bins.mjs`) judges what pnpm actually linked: no bin named like anything on the
  image's PATH; no package outside the toolchain declaring a toolchain command (a fixed list, so
  dropping a toolchain package does not free its name, nested bin directories included); every
  linked toolchain command pointing into a toolchain package in pnpm's store, where a slice cannot
  write (whatever pnpm linked it for, peers included; a shim whose target it cannot read is
  refused); no dependency manifest it cannot read.

Slices may still add, upgrade and drop ordinary dependencies.

## Alternatives considered

- **A separate Unix user for the agent inside the one container.** The reviewers would still
  share a kernel namespace, a file system and the loop's process tree with the agent. Separate
  containers controlled by the host are a stronger, simpler boundary.
- **Moving every review round to the host.** Each fix round would need a new agent container and
  a cross-container pause/resume. The loop's rounds remain useful for converging; one final,
  authoritative round on the host is what makes the decision trustworthy.
- **Read-only workspace for every stage.** TypeScript and Turbo write caches into the workspace,
  and they execute none of the slice's code. Only the test stage needs it.
- **Forbidding dependency changes.** Five of the first eight slices changed the lockfile. Pinning
  the toolchain's closure keeps what judges a slice fixed without blocking ordinary work.
- **Trusting a reporter file of the test runner.** Anything the slice's code can write, it can
  forge. Exit status observed by Docker is the only channel the code cannot reach.

## Consequences

- Each merged ticket costs a host review: two more reviewer sessions. The staged gate takes a few
  minutes longer than the single container did.
- Changing test configuration, `tsconfig*.json`, the test infrastructure, Prisma generators or the
  toolchain's versions (including adding an optional peer that changes a toolchain package's
  locked entry), and adding a workspace package that needs its own Vitest configuration, now
  takes a human-reviewed commit. The run's work stays on a quarantine branch to build on.
- A run that merges several tickets is accepted all or nothing: if the host does not approve one
  of them, none of the run lands. The batch runs one ticket per run.
- **Remaining limitations:**
  - **Prompt injection.** The reviewers are language models reading code the agent wrote. Code
    or comments crafted to mislead them can still bias a review. The host's gate checks the
    reports' evidence (token, range, files, hunks, criteria and tests that exist), not their
    judgement. The deterministic gate and GitHub CI do not depend on the reviewers.
  - **Within one package's test run**, the slice's tests share a user, a process tree and the
    services with the Vitest main process. Yama stops them from tracing it, and the workspace is
    read-only, but a test can still affect other tests of the same package through shared state
    (the database, the temporary directory, the IPC channel of its own worker). Such code is in
    the diff the host's reviewers read.
  - **Install.** The prepare stage has network access, to fetch packages. It executes only
    trusted code (pnpm, the base's build-script packages, the Prisma generator), but it downloads
    whatever the lockfile names for new ordinary dependencies.
  - **Hoisted modules.** pnpm hoists every package into `node_modules/.pnpm/node_modules`. A
    toolchain package that loads a module it does not declare could pick up one a slice added.
  - **Accepted code is not contained.** As ADR 0014 says, merged code runs on developer machines
    and in GitHub CI, which execute it with their own privileges.
  - **The reviewers hold the model credential**, as the agent does. They have no tools that
    write or execute, and no other credentials.
  - **Kernel and Docker** are trusted. A container escape or a kernel without Yama defeats the
    test-stage isolation; the test stage refuses to run without Yama.
