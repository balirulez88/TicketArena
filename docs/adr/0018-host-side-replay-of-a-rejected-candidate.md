# 0018: Host-side replay of a rejected candidate

- **Status:** Accepted
- **Date:** 2026-11-08
- **Extends:** [0014](0014-sandbox-trust-boundary.md), [0015](0015-review-and-verification-isolation.md), [0017](0017-opt-in-lead-driver.md)

## Context

The lead pilot of ticket 56 produced an implementation whose host review found nothing above LOW,
yet blocked the merge because one acceptance criterion described documentation and so could not be
verified by a test. The fault was in the ticket. The importer cannot take the preserved work
again: it requires the archived ticket to equal the base's ticket plus `done`, and the base's
ticket has since been amended. The only remaining route was to pay for a new implementation.

## Decision

`scripts/ralph-replay.mjs` is a host-side tool, run by a human from a clean checkout of the base
branch, never inside the sandbox. For a quarantine branch pinned by its full commit it:

1. refuses unless the host itself recorded the rejection: a `chore(issues): block issues/<slug>.md
   after the host review` commit on the base's first-parent history (only the importer writes
   there) names the branch and the candidate's commit. A quarantine branch a container made
   itself was never host-reviewed and is not replayable. It also refuses unless the branch is that commit, one slice commit on an ancestor of the base, and every
   path it changes (apart from archiving its own ticket) is byte-identical on the base to what the
   candidate started from. Symlinks and submodules are refused. The branch is never written;
2. reproduces the implementation changes on the base and archives the **base's** ticket
   (`ready-for-agent`, as amended) as `done`, then merges with an identical tree, producing the
   same `result.bundle` shape a container leaves;
3. re-proves RED against the base: base plus only the candidate's test files, in the hardened
   offline container (`ralph-verify.mjs --red`, `sandbox-entrypoint.sh --red`);
4. with `--accept`, runs the unmodified `ralph-accept.mjs` on that bundle.

The bundle is as untrusted as any container's. Protected-path rules, the debt gate, the hardened
re-run of the gate and fresh, independent Standards and Spec reviews all run in the importer, as
for any slice. The replay records no verdict, reads none of the earlier attempt's logs or reviews,
and is not part of the sandbox image (the agent's workspace clone does contain the file, but running it there only touches that container). A ticket must be `ready-for-agent` on the base, so
the ticket's `blocked` state is left in a reviewed commit, not by this tool.

## Consequences

- The RED proof is evidence of test-first shape, not an adversarial check: its verdict is computed
  by `ralph-red.mjs` from a report the tested code could in principle rewrite (unlike the gate's
  test stage, whose verdict is Vitest's exit status). Nothing depends on it for safety: the
  importer's gate and the fresh reviews still judge the code.
- The replay refuses paths that are not printable ASCII or that have a component starting with `-`
  (they could be read as options by the tools that receive them), and runs git with literal
  pathspecs.
- Recovering work lost to a ticket defect costs two reviewer sessions, not a new implementation.
- A candidate whose code the host review found faulty is not rescued: the fresh review decides.
- `RALPH_REPLAY_RED` replaces the RED container for tests of the tool only, like
  `RALPH_ACCEPT_VERIFY` for the gate. It is host environment, not reachable by an agent.
