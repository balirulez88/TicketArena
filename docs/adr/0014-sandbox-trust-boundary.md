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
  its own Git into a quarantine namespace (`refs/ralph/incoming/<run>/`). Before that, every
  object the bundle adds is checked strictly (`index-pack --strict --fsck-objects`) in a scratch
  repository, so a malformed object never reaches the host's object store.
  The host never runs Git inside a repository the container wrote, so no hook or config of the
  container's can execute on the host.
- **Acceptance** (`scripts/ralph-accept.mjs`, the only code that changes the host from a run):
  - `main` may only gain Ralph-shaped results. A slice merge is one squashed commit on the
    verified base under `Merge slice/<slug>:` with an identical tree, for a ticket that was ready
    with every blocker done, archived as done and otherwise unchanged. A blocked-status commit
    changes only that ticket's status line.
  - No change may touch a protected path (the harness, `scripts/`, CI, review skills,
    `docs/workflow/`, gate and workspace configuration, `infra/` and Compose files, anything
    pnpm runs on install in any package, the root manifest except its dependencies, every
    package's gate scripts, and what Claude Code and editors load by themselves: `CLAUDE.md`,
    `.claude/`, `.mcp.json`, `.vscode/`), Git attributes or submodules, or add a symlink or
    submodule. Nor may it write a path the host keeps out of
    Git (`.ralph/`, `.env*`, `node_modules/`, anything the host's ignore rules match): a
    fast-forward would overwrite such files silently. Paths are compared as a case-insensitive
    host resolves them, and names that host could resolve elsewhere, or two names for one file,
    are refused.
  - The full gate runs again on the merged tree, in a fresh sandbox with no agent. The register
    check runs first, before `pnpm install` or any code of the slice.
  - A pause is adopted only if it is exactly what Ralph writes, for parked work that is in the
    bundle and sits on the base. The host rewrites it in canonical form.
  - Anything else is refused (exit 3). The host is unchanged and the result is kept for
    inspection. The batch stops finally on a refusal (`untrusted-result`).
- **Host-only state:** `.ralph/batch` and `.ralph/state` are never mounted, and no accepted
  result can write them (see the host-only path rule). Logs are copied in as plain files, without
  links, size-capped and redacted; the container's raw copy is then deleted. Logs are never
  consulted for a decision.

## Alternatives considered

- **Read-only mount of the host repository.** This blocks writes, but it still exposes every ref
  and object, and it needs a separate write path anyway. A bundle is the same data with a
  narrower interface.
- **A staging repository on a host volume, fetched from directly.** A local fetch runs Git in a
  repository whose config the container wrote. A bundle is just a file.
- **Trusting Ralph's in-container gates and checking only the merge shape.** The agent runs as
  the same user as the gates, so their verdicts can be forged inside the container. Re-running
  the deterministic gate without the agent closes that for a forged verdict. It does not close a
  slice whose own code is written to subvert the gate it runs in (see Consequences).
- **Re-running the LLM reviews on the host.** That would cost another full review round per
  ticket and change the review loop (no FIX round after it). Deferred: see Consequences.

## Consequences

- A slice can no longer change the harness or the gate definitions. Such changes need a
  human-reviewed commit, like this one.
- Every merged ticket costs one more agent-free gate run (minutes of compute, no model tokens).
- `pnpm sandbox` needs a clean `main` checkout to start. The sandbox no longer uses Ralph's
  `ralph/blocked-*` side-branch fallback for a dirty checkout; it remains only for Ralph runs
  outside the sandbox.
- **Remaining limitations** (the first two are closed by [ADR 0015](0015-review-and-verification-isolation.md),
  which has the current threat model):
  - Inside the container, the agent runs as the same user as Ralph's gates and reviewers. A
    deliberately malicious agent could leave a background process that rewrites a review report
    before the in-container review gate reads it. The host re-runs the deterministic gate, checks
    the merge shape and protected paths, and GitHub CI runs after the push. The approval of the
    two LLM reviews, however, is still produced inside the container (TD-058).
  - The re-run gate and CI execute the slice's own code: its tests, its `vitest.config` and
    `tsconfig.json` (real slices need to change them), and the dependencies its lockfile
    resolves. Code written to subvert the gate can therefore narrow what the gate covers, or
    tamper with the tooling and the later gate steps in its own checkout, so a lint, typecheck
    or test result is only as trustworthy as the slice that produced it. The register check runs
    before any slice code, and install scripts are refused, but only the reviews
    judge the rest, and their verdicts are the in-container weakness above (TD-058).
  - Accepted code is not contained. Once merged, it runs wherever the repository is used: on
    developer machines (the tests, `infra:up`, and on `pnpm install` the build scripts of any
    dependency `allowBuilds` permits), in GitHub CI, and in the agent-free re-gate. The re-gate has no credentials but
    has network access. The boundary protects the host's repository, harness and decisions from
    the agent while it runs; what may be merged is decided by the gates and the reviews.
  - Container output reaches the operator's terminal while a run is in progress. The importer
    masks control characters in what it prints, but Docker's own output stream is passed
    through as it is.
  - The agent necessarily holds its own model credential. It has no host or GitHub credentials.
