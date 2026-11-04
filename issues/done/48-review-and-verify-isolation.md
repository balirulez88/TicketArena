# 48: Isolated reviewers and hardened verification

**What to build:** an enforceable trust boundary between the development agent, the independent reviewers and the trusted host. The host stops relying on anything the agent's container decided. It runs its own Standards and Spec reviews of the exact candidate, each in a separate disposable container, and judges their reports itself. It runs the quality gate on agent-written code in hardened, offline, disposable containers whose only result is their exit status. Resolves TD-058 in `docs/technical-debt.md` (HIGH, security). Until this merges, autonomous production batches stay blocked. This is a harness and security change, reviewed and merged outside Ralph: a sandboxed agent must not author its own trust boundary.

**Priority:** HIGH (security; blocks autonomous production batches)

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-04 by harness/48-review-and-verify-isolation (reviewed by independent host-side Standards and Spec reviewers and merged outside Ralph)

### Reviewers isolated from the development agent

- [x] The host (`scripts/ralph-accept.mjs`) accepts a slice only after its own review: a Standards reviewer and a Spec reviewer, each in its own fresh, disposable container, each a fresh session. Nothing the agent's container wrote is consulted: its review reports, decision files and approvals are logs, never evidence.
- [x] Each reviewer receives a read-only snapshot of exactly the candidate slice commit, plus a changeset, prompt and schema built by the host with a fresh host-generated token. It has no output mount, no Docker socket and no host repository; its tools only read, and its workspace has its write permissions removed. Its report is read from its standard output by the host.
- [x] The host validates both reports with the review gate (`scripts/ralph-review.mjs`), against the candidate's real changeset, commit range, token, ticket and debt register, with test references resolved in the candidate's tree. Both axes must be valid and approve that exact candidate. A missing, forged, malformed or mismatched report is never an approval.
- [x] Fresh-session isolation and the review limits are preserved. The in-container rounds (up to `RALPH_MAX_REVIEW_ROUNDS`) still drive the fix loop. The host review is one final round, in which an invalid report is asked for once more, as in the loop.
- [x] A host review that does not approve leaves `main` without the slice: the host blocks the ticket in its own commit and keeps the candidate on `rejected/<slug>-<run>`, so the batch stops as `rejected`. A reviewer the provider cut off leaves `main` untouched and the batch stops resumably (`runner-failed`).
- [x] The approved host review's deferred findings are recorded in the debt register by the host, in a host commit after the merge, and no register entry of the base may be lost.

### Verification protected from agent-controlled code

- [x] The re-gate runs in disposable containers: a preparation container installs the candidate's dependencies, then each gate stage runs in its own container from that prepared workspace. Every container drops all capabilities, cannot gain privileges, has memory, CPU and process limits and a host-enforced timeout, and mounts no host path, credential, Docker socket or authoritative state.
- [x] The stages that execute agent-written code (each workspace package's tests) run with no network (services on the container's loopback only), a read-only root file system and a read-only workspace, one container per package. So a test cannot rewrite other tests, sources, dependencies, the harness or a later stage's input.
- [x] The host's verdict is only the exit status of each container, observed by Docker. No file, log or output of a stage is consulted. The test containers refuse to run unless the kernel restricts `ptrace` to descendants (Yama `ptrace_scope` ≥ 1), so a test cannot rewrite the runner that reports on it.
- [x] Everything that runs in a trusted role during verification is fixed by the base: per-package Vitest and Vite configuration, `tsconfig*.json`, the shared test infrastructure (`packages/test-infra/`, whose global setup runs inside the Vitest main process), `prisma.config.*`, Prisma `generator` blocks, the `db:generate` scripts, a new package's gate scripts other than `test` (they must run commands the base's packages already run), the commands the gate runs by name (no package outside the toolchain may link a bin shadowing a toolchain command or a command on the image's PATH, checked after install and before any script), and the toolchain's locked dependency closure, `link:` resolutions included: Vitest, Vite, TypeScript, Turbo, Biome, Prisma, esbuild, the test infrastructure's dependencies, the packages allowed to run build scripts, and pnpm's own lockfile document. Slices may still add and change other dependencies.
- [x] Functional and integration test coverage is unchanged: every package's `test` script runs against real Postgres, Redis and NATS, as before.

### Security regression tests

- [x] Unit tests (`scripts/ralph-accept.test.mjs`, `scripts/ralph-host-review.test.mjs`, `scripts/ralph-bins.test.mjs`): the agent's own review outputs and approval files cannot satisfy the host's review gate; forged reports (wrong token, wrong commit range, wrong axis, missing axis, unparseable) are not approvals; reviewers are given the exact candidate; a rejected host review blocks the ticket and leaves `main` alone; the gate verdict comes only from the verifier's exit status; every new protected path and lockfile rule refuses its attack.
- [x] Real Docker (`pnpm test:sandbox`): a malicious agent whose test rewrites another test, probes the network and host state, and passes inside its own container, is refused by the host's hardened re-gate. A slice linking a package whose bin shadows `node` is refused before that bin runs. A slice the in-container reviewers approved but the host's isolated reviewers block is not merged. The reviewer containers see the exact candidate, read-only, with no output mount. Normal merges, rejections, pause and resume still work.

### Documentation and debt

- [x] An ADR records the reviewer and verifier isolation, its threat model and its remaining limitations; `docs/workflow` describes the new host stages. TD-058 is `RESOLVED` with the verifying tests named in `Verification`.
