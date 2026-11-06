# 0017: Opt-in lead driver for ticket execution

- **Status:** Accepted
- **Date:** 2026-11-06
- **Extends:** [0014](0014-sandbox-trust-boundary.md), [0015](0015-review-and-verification-isolation.md), [0016](0016-risk-based-debt-gate.md)

## Context

Two runs of ticket 12 spent a large part of a usage window and merged nothing. Ralph's loop starts
a cold `claude -p` session for each phase (RED, GREEN, REFACTOR, DOCS, every FIX) and for each
reviewer in each round, forbids resuming and compaction, and re-reviews the whole diff each round.
The agent re-derives the repository, the ticket and the debt register in every session, and a fix
session sees only the finding it was handed, not the rule behind it. Both runs ended on the same
kind of finding in a different file: "criterion N is partial".

Discovery and planning (`/grill-me`, `/to-spec`, `/to-tickets`) are not the problem and do not
change. Neither does anything on the host: the sandbox, the importer, the debt gate, the isolated
verification and the host's own review (ADR 0014 to 0016) judge the same way whatever produced the
candidate.

## Decision

An **execution driver** is chosen per run. `RALPH_DRIVER` unset or `ralph` runs `ralph-loop.sh`,
as before. `RALPH_DRIVER=lead` runs `scripts/ralph-lead.sh` instead. Anything else is refused
(exit 2) before a container exists, and so is the lead without an explicit `--ticket NN`: the lead
works exactly one ticket per run and never selects, and pays for, work on its own.

### What the lead driver is

One Lead session per ticket keeps its context for the whole ticket. It delegates editing to an
Implementer subagent and may call a read-only Reviewer subagent **once**
(`.claude/agents/ticketarena-*.md`). There is no review loop. The Lead has no authority: it cannot
approve or merge. Its review is advisory, because the host's isolated Standards and Spec review of
the exact candidate commit (ADR 0015) decides the merge, as it does for Ralph.

The driver sources `ralph-loop.sh` and reuses, unmodified: ticket selection and the debt gate,
`run_gate` (lint, typecheck, test, debt rules), `verify_red` with `ralph-red.mjs`,
`finalize_slice`, `reject_slice`, the artifact lifecycle and the provider classifier. It differs
from Ralph in four places:

1. **RED is re-proved by the harness.** The Lead writes tests and code in one session, so the
   harness resets to the base commit, applies only the candidate's `*.test.ts(x)` and
   `__fixtures__/` files, and runs `verify_red`: lint passes, the tests load and execute, at least
   one fails. A candidate without that evidence is rejected, as in Ralph. The cost: a test that
   needs a new non-test helper file, or imports a module the base lacks, fails to load and is
   rejected, exactly as in Ralph's RED phase.
2. **Git must be as the harness left it.** If the Lead changed the branch or the base, the
   candidate is not judged or merged.
3. **No retry, no fallback.** A session that fails, times out, hits a provider limit or is
   interrupted is never repeated, never handed to the Ralph driver, and never blocks the ticket.
   The work is saved as `<slug>.lead-work.patch` in the run's logs (which the host imports) and the
   run exits 1. A judged candidate that fails RED or the gate is rejected like Ralph's (quarantine
   branch, ticket blocked). Running again is a human decision.
4. **Compaction stays on** (`fresh_session` turns it off), because one session carries the whole
   ticket. The Lead stays small by delegating the reading and editing.

### Trust boundary

Unchanged. The Lead and its subagents run in the same container as Ralph's agent
(`--cap-drop ALL`, no host mounts beyond the two run directories) and everything they produce is
untrusted data to `ralph-accept.mjs`: path rules, lockfile rules, the debt gate, the hardened
agent-free re-gate and the host's isolated review all run on the exact candidate. `ralph-lead.sh`,
`ralph-driver.sh`, `.claude/agents/` and `docs/workflow/` are protected paths: a run cannot change
its own driver or its reviewer. The entrypoint selects the driver from its own copy of
`ralph-driver.sh` in the image, not from the workspace.

The entrypoint forwards `SIGTERM`/`SIGINT` to the lead driver (only), because a PID 1 shell would
ignore `docker stop` and the container would die with no bundle and no logs.

### Usage accounting

The Lead's `claude -p --output-format=json` result is kept as `<slug>.lead.json`, and
`scripts/ralph-usage.mjs` totals tokens and the CLI's reported cost over any result files (the
Lead's, and the reviewers' reports where they keep them). The dollar figure is the CLI's API-price
arithmetic. It is **not** subscription usage and cannot be converted to it; tokens are the
comparable quantity, and a plan's own meter is read before and after.

## Consequences

- Ralph stays the default and the fallback, and its code is untouched.
- Adding a driver adds a way to spend: the lead can run only when asked, for one named ticket.
- A candidate the Lead gets wrong costs one session and ends in a rejection or a stop with
  evidence, never in an automatic second run.
- The Lead's own review catches less than Ralph's multi-round loop and the host review is the gate;
  a blocking host finding blocks the ticket as it does for Ralph.

## Not decided here

Whether the lead driver is better. It is judged on one pilot ticket, against Ralph's recorded runs,
before anything else depends on it.
