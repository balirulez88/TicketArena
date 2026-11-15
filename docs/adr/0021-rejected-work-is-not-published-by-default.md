# 0021: Rejected work is not published by default

- **Status:** Accepted
- **Date:** 2026-11-14
- **Extends:** [0014](0014-sandbox-trust-boundary.md)

## Context

A rejected run's work is unreviewed agent output. `ralph-loop.sh` pushed its quarantine branch to
`RALPH_PUSH_REMOTE` after every rejection, so the evidence would survive a disposable clone. In
the sandbox that remote is the container's own staging repository, which the host validates
(ADR 0014). Outside the sandbox it can be GitHub: `rejected/12-lock-timeout-and-deadlock-retry-20261106-132615`
reached the public repository that way (TD-059). A published branch can carry credentials, and
its own `.github/workflows` would run with the repository's secrets. The loop also pushed paused
work (`ralph/paused/*`) and deleted it from the remote after a resume.

## Decision

- **Default: nothing leaves.** Outside the sandbox's staging repository, `ralph-loop.sh` never
  pushes a quarantine branch or paused work. The work stays on its local branch, and the log says
  so. The blocked status on the base branch is not agent work and is still pushed.
- **Staging is recognised, not assumed.** A remote counts as staging only when `RALPH_SANDBOX=1`,
  the entrypoint set `RALPH_STAGING_REMOTE` to its staging repository's path, that path is a
  directory, and every push URL of `RALPH_PUSH_REMOTE` (`git remote get-url --push --all`, so a
  `pushurl` or `pushInsteadOf` cannot divert it) is an existing local directory that resolves to
  that same directory (compared physically, since Git may spell one path two ways). A wrong or
  missing marker only ever keeps work local. An operator who sets these variables by hand on the host can make a
  local directory count as staging; that publishes nothing beyond the machine, but it is an
  environment-level exemption, which is why only the entrypoint sets them.
- **A rejection that cannot be trusted publishes nothing.** If HEAD is no longer the slice branch,
  or the base branch moved since the ticket started (an agent that broke the no-git rule),
  `reject_slice` stops with an error before committing, moving or pushing anything.
- **An exception needs two things, for one run.** `--push-rejected NN` on the command line
  authorizes pushing ticket NN's quarantine branch in this invocation only. There is deliberately
  no environment variable, config or default for it, so no authorization carries over. Then
  `scripts/ralph-push-inspect.mjs` must pass on exactly the commits the push would send (those
  reachable from the branch that the remote does not have, from `git ls-remote`): no `.github/`,
  env (`.env`, `.env.*` except `.env.example`) or key files; no credential pattern (private keys,
  cloud and API tokens, JWTs, connection strings with a password, credential assignments) in an
  added line or commit message; no binary content. A finding, a failure or an inspection that
  cannot run blocks the push. The commit is resolved once, and that exact commit is inspected and
  pushed. Findings name the commit, file, line and rule, never the match, and
  printed Git errors have URL credentials removed.
- **No automatic remote deletion.** The harness deletes a remote ref only in the sandbox's staging
  repository. Anywhere else an obsolete ref is evidence; removing it is a maintainer's explicit
  decision, after the evidence is preserved (ticket 52's maintainer steps).

The batch already pushes only the base branch, and the importer creates quarantine branches only
locally; neither changes.

## Alternatives considered

- **Push to a private evidence remote.** Still publication outside the machine, and a second
  remote to secure; local branches and `.ralph/logs` already keep the evidence.
- **Authorization alone.** An operator approving a push cannot see what an agent wrote; the
  inspection is the check, the authorization is the intent.
- **An allowlist for known test fixtures.** Every allowlist entry is a way past the check; a false
  positive costs only a push that does not happen.

## Consequences

- Rejected and paused work outside the sandbox lives only on the machine that ran it.
- Publishing rejected work is a deliberate, inspected, per-run act, and the inspection's
  conservative rules may refuse harmless work (for example a test fixture with a connection
  string). That is the intended trade.
- The quarantine namespace move (`refs/ralph/rejected/`), the remaining part of TD-059, is
  separate work under ticket 52.
