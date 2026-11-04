# 0014: Sandbox trust boundary

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

Ralph's agent runs with permission prompts disabled, so it can run any command in its container.
Until now, the container mounted the whole host repository read-write. Only convention kept the
agent in its own clone. A misbehaving agent could have written the host's Git refs, hooks and
config, the scripts the batch runs on the host (`ralph-ci.sh`, `sandbox.sh`, ticket selection),
and the batch and resume state (TD-057, HIGH). From there it could forge a merge or a CI pass,
run code on the host where GitHub credentials live, or forge checkpoints. Autonomous production
batches are blocked until this is fixed.

## Decision

The container gets no part of the host repository. Everything it produces is untrusted data until
a trusted host step has validated it.

- **Mounts:** only `/ralph-in` (read-only: a Git bundle of `main` and parked work, plus the
  host's resume state) and `/ralph-out` (this run's output). There is no Docker socket, no host
  Git metadata and no credentials besides the agent's own model key. The container runs with
  `--cap-drop ALL` and `no-new-privileges`.
- **Transport:** inside the container, Ralph pushes to a staging bare repository that only the
  container has. At exit, its branches leave as `result.bundle`. The host reads that bundle with
  its own Git into a quarantine namespace (`refs/ralph/incoming/<run>/`, objects fsck-checked).
  The host never runs Git inside a repository the container wrote, so no hook or config of the
  container's can execute on the host.
- **Acceptance** (`scripts/ralph-accept.mjs`, the only code that changes the host from a run):
  - `main` may only gain Ralph-shaped results. A slice merge is one squashed commit on the
    verified base under `Merge slice/<slug>:` with an identical tree, for a ticket that was ready
    with every blocker done, archived as done and otherwise unchanged. A blocked-status commit
    changes only that ticket's status line.
  - No change may touch a protected path (the harness, `scripts/`, CI, review skills,
    `CLAUDE.md`, `docs/workflow/`, gate and workspace configuration, `infra/`, the root
    `package.json` scripts and every package's gate scripts), Git attributes or submodules, or
    add a symlink or submodule. Paths are compared as a case-insensitive host resolves them, and
    names that host could resolve elsewhere, or two names for one file, are refused.
  - The full gate runs again on the merged tree, in a fresh sandbox with no agent.
  - A pause is adopted only if it is exactly what Ralph writes, for parked work that is in the
    bundle and sits on the base. The host rewrites it in canonical form.
  - Anything else is refused (exit 3). The host is unchanged and the result is kept for
    inspection. The batch stops finally on a refusal (`untrusted-result`).
- **Host-only state:** `.ralph/batch` and `.ralph/state` are never mounted. Logs are copied in as
  plain files, without links, redacted, and never consulted for a decision.

## Alternatives considered

- **Read-only mount of the host repository.** This blocks writes, but it still exposes every ref
  and object, and it needs a separate write path anyway. A bundle is the same data with a
  narrower interface.
- **A staging repository on a host volume, fetched from directly.** A local fetch runs Git in a
  repository whose config the container wrote. A bundle is just a file.
- **Trusting Ralph's in-container gates and checking only the merge shape.** The agent runs as
  the same user as the gates, so their verdicts can be forged inside the container. Re-running
  the deterministic gate on the host closes that for lint, typecheck, tests and the register.
- **Re-running the LLM reviews on the host.** That would cost another full review round per
  ticket and change the review loop (no FIX round after it). Deferred: see Consequences.

## Consequences

- A slice can no longer change the harness or the gate definitions. Such changes need a
  human-reviewed commit, like this one.
- Every merged ticket costs one more agent-free gate run (minutes of compute, no model tokens).
- `pnpm sandbox` needs a clean `main` checkout to start. The sandbox no longer uses Ralph's
  `ralph/blocked-*` side-branch fallback for a dirty checkout; it remains only for Ralph runs
  outside the sandbox.
- **Remaining limitations:**
  - Inside the container, the agent runs as the same user as Ralph's gates and reviewers. A
    deliberately malicious agent could leave a background process that rewrites a review report
    before the in-container review gate reads it. The host re-runs the deterministic gate, checks
    the merge shape and protected paths, and GitHub CI runs after the push. The approval of the
    two LLM reviews, however, is still produced inside the container (TD-058).
  - The re-run gate and CI execute the slice's own tests, so they are only as strong as those
    tests. A slice may still change a package's `vitest.config` or `tsconfig.json` (real slices
    need to), so a malicious agent could narrow what the gate covers for that package. Only the
    reviews judge that, and their verdicts are the in-container weakness above (TD-058).
  - Accepted code is not contained. Once merged, it runs wherever the repository is used: on
    developer machines (`pnpm install` with the build scripts `allowBuilds` permits, `infra:up`,
    the tests), in GitHub CI, and in the agent-free re-gate. The re-gate has no credentials but
    has network access. The boundary protects the host's repository, harness and decisions from
    the agent while it runs; what may be merged is decided by the gates and the reviews.
  - Container output reaches the operator's terminal while a run is in progress. The importer
    masks control characters in what it prints, but Docker's own output stream is passed
    through as it is.
  - The agent necessarily holds its own model credential. It has no host or GitHub credentials.
