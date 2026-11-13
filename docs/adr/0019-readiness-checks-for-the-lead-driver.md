# 0019: Readiness checks for the lead driver

- **Status:** Accepted
- **Date:** 2026-11-08
- **Extends:** [0014](0014-sandbox-trust-boundary.md), [0015](0015-review-and-verification-isolation.md), [0016](0016-risk-based-debt-gate.md), [0017](0017-opt-in-lead-driver.md)

## Context

The lead run of ticket 54 finished the work, then was rejected at the RED proof: one test imported
`@neondatabase/serverless`, which its package declared only in the candidate, not on the base. RED
was right. The cost came from when it was found. Only the RED proof compares anything with the
base; every check the agent can run sees the working tree, where the dependency it just added
exists. The ticket did not name the package and the Lead's plan was valid: the import arrived in
the fix for a review finding. A check at the start of a run could not have seen it.

## Decision

`scripts/ralph-preflight.mjs` answers the deterministic questions without a model call. It has no
dependencies, so it runs in any repository and on every tool call. Findings give the verdict:
`READY` (0), `NEEDS PREPARATION` (5: a small human change would fix it) or, from the driver's
existing checks, `BLOCKED` (1). A check that could not run exits 2. Four integration points, each
reusing what exists:

| When                      | Where                      | What                                                                                                                                                                                         |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before any image is built | `sandbox.sh` → `--dry-run` | `next_ticket` (status, blockers, debt gate); a criterion that names documentation and no test; a workspace package the base lacks; unresolved debt entries that mention flakiness, as a note |
| Before the Lead starts    | `lead_baseline_green`      | `run_gate` on the base, unless the host already verified this code. One failure then a pass is reported as flaky                                                                             |
| After each edit           | `.claude/settings.json`    | the imports of the tree's test files against the base; a new finding goes back to the agent then working, in the same session                                                                |
| After the session         | `lead_candidate_ready`     | the same check on the exact candidate commit, immediately before RED. **Mandatory**, whether or not the hook ran                                                                             |

**The import check reads the base from git** and reuses `ralph-red.mjs`'s planner. A test may load
only what its owning package or the root declares on the base, or files that exist there or are
carried into the proof. Only what fails at load time counts: an import inside a test body fails
inside the test, which RED accepts. The manifests a candidate changes must also agree with the
lockfile, or the host's frozen install fails.

**Baseline results are reused only when safe.** `sandbox.sh --verify` records a key of the commit's
tree, leaving out `issues/` and the debt register, which the host commits to right after it
verifies a slice. A later run on the same key skips the baseline run, so the importer's own gate is
not run twice. The record is a hint the host passes in; it can only skip that one run.

**Stopping is not rejecting.** A finding before RED stops through `lead_stop`: nothing is judged,
the ticket is not blocked, the work is saved as `lead-work.patch`. The script reports 5, the
driver's run exits 1, like any other stopped session. A check that cannot run also stops, so it is
never read as a pass. An import the agent cannot avoid ends the session there, without a handoff,
because every further step would be paid for work that cannot be accepted; the driver reruns the
check on the working tree so that the stop is reported as `NEEDS PREPARATION`.

### Trust boundary

Unchanged. A finding can only stop a run early. RED, the gate, the importer's rules and the host's
review run exactly as before and read nothing this check produced. The hook runs in the agent's
container, where the agent can disable it; that gains nothing, because the check before RED and RED
itself still run. `scripts/` and `.claude/` are protected paths.

### Why project settings, not agent frontmatter

Measured in the real sandbox image with a real Implementer subagent (`claude` 2.1.312, the Lead's
flags and an empty config directory): a hook in the agent's frontmatter did not fire, in block or
flow YAML, while the same command in `.claude/settings.json` fired for the subagent and its
feedback reached it. `pnpm run format` also flattens nested frontmatter YAML. The hook does nothing
unless `RALPH_BASE_SHA` is set, which only the lead driver does. The session logs each firing to
`.ralph/lead/preflight-hook.log`, exported with the handoff, and the driver notes a session in
which it never fired. Only a `Write` by the first Implementer pass was measured. `Edit` and `Bash`
are in the same matcher, but their firing and a review-fix pass have not been observed, which is
one reason the check before RED does not depend on the hook.

## Consequences

- A dependency the base lacks is designed to be reported when it is written, in a review-fix pass
  too, with the limit stated above. A finding is delivered once: a later agent facing the same,
  unchanged finding hears nothing from the hook and is stopped before RED instead.
- It does not catch what only execution reveals: a missing named export used at load time or an
  import nested in a `describe` callback. RED still decides each of them.
- An alias defined only in a Vitest config is reported as missing, a false stop: the check reads
  `tsconfig` paths and manifests, not Vitest's configuration.
- The ticket check is a text heuristic, not a judgement of testability, and it can be wrong in both
  directions. It flags a criterion that names documentation and no test, which is what the host
  review blocks, and has no override: a human fixes the ticket, in a reviewed commit. Plans and
  checklists are not evaluated, because they exist only once the Lead has run.
- When a baseline result is reused nothing exercises the test services before the session. Open
  flaky entries come from the debt register, so a flaky test nobody recorded is not listed.
- Ralph, the default driver, is unchanged. The script is not specific to the lead driver.
