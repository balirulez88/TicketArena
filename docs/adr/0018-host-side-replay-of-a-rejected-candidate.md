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

1. refuses unless the branch is that commit, one slice commit on an ancestor of the base, and every
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
and cannot be reached from the sandbox image. A ticket must be `ready-for-agent` on the base, so
the ticket's `blocked` state is left in a reviewed commit, not by this tool.

## Consequences

- Recovering work lost to a ticket defect costs two reviewer sessions, not a new implementation.
- A candidate whose code the host review found faulty is not rescued: the fresh review decides.
- `RALPH_REPLAY_RED` replaces the RED container for tests of the tool only, like
  `RALPH_ACCEPT_VERIFY` for the gate. It is host environment, not reachable by an agent.
