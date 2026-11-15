# 0020: Global, fail-closed debt hold

- **Status:** Accepted
- **Date:** 2026-11-14
- **Amends:** [0016](0016-risk-based-debt-gate.md)

## Context

ADR 0016's `Blocks` field names the tickets an entry holds, one by one. On 2026-11-14 a rejected
branch was found on the public remote (TD-059), and the maintainer decided that no Ralph
production run may start until ticket 52 makes rejected work safe. Expressing that with an
explicit list had two weaknesses:

- **A new ticket was clear by default.** A ticket Ralph can select that was created after the
  list was written was not on it, so its commit had to add the number by hand. One missed edit
  would have let Ralph start.
- **Nothing failed closed.** A `Blocks` value the gate could not read was a register error for
  the CLI, but the importer and the batch only parse the register; an unrecognised value could
  hold nothing there.

## Decision

`Blocks` gains a third form, the global hold: `Blocks: ALL_AGENT_TICKETS`, alone.

- **What it holds.** Every unfinished ticket whose status is not `ready-for-human`, resolved
  against the tickets each time the gate runs: tickets created later are held without any edit,
  and so is a ticket with a missing or misspelt status. `ready-for-human` tickets are never taken
  by Ralph, the batch, the Lead driver or the importer (they accept only `ready-for-agent`), so
  remediation worked by hand in Claude Code stays possible and bypasses nothing.
- **Verdict.** A triaged unresolved global entry makes every held ticket `waiting`, with the
  reason `TD-NNN (<risk>) holds every ticket not ready-for-human until ticket NN resolves it`. An
  entry sent back to triage makes them `needs-triage`. Resolving the entry releases them all.
- **Validation** (`check:debt`, the batch, the loop): the value is exactly `ALL_AGENT_TICKETS`,
  never combined with numbers; the entry has an owner (`Target: ticket NN`); the owner is
  `ready-for-human` (otherwise the hold would stop its own fix); it is not `ACCEPTED_RISK`; and
  the owner does not build on a held ticket (the dependency-cycle check covers the expanded hold).
- **Failing closed.** `debtGate` itself treats any `Blocks` value it cannot read as holding every
  ticket (`needs-triage`), so callers that only parse the register (the importer) are closed too.
  The CLI prints no verdict for a missing, unreadable or invalid register; `ralph-loop.sh` then
  stops with an error (at start, before selecting anything, and again when its queue ends, so a
  register broken mid-run is not reported as an empty queue), and a
  ticket without a verdict line is never `clear`. Each run, of either driver, keeps the verdicts
  it selected by in `.ralph/logs/<run>/debt-gate.tsv`; the Lead driver stops the same way.
- **Enforced where agent work starts, not only at selection.** Selection is one caller; a bug in
  it, or a future entry point, must not reach an agent with a held ticket. So the gate is asked
  again for the one ticket at the moment its work starts or resumes (`require_debt_clear` in
  `process_ticket` and in the Lead's `lead_ticket`, before any branch, status or file changes),
  and only `clear` proceeds: `waiting`, `needs-triage`, no verdict line, or a gate that cannot run
  all refuse. Every launcher of agent sessions (`run_agent`, `run_review`, `lead_session`) refuses
  unless that check cleared exactly the current ticket in this process. Each check appends its
  verdict (time, driver, ticket, verdict, the base commit it judged, reasons) to
  `.ralph/logs/<run>/debt-gate-verdicts.tsv` before acting on it, and a verdict that cannot be
  recorded refuses too. Sabotage scenarios in `scripts/ralph-safety.test.sh` and
  `scripts/ralph-lead.test.sh` hand each driver a held ticket below selection and call each
  launcher without a verdict.

A maintainer may set the global hold only in a reviewed commit with a history line (as for any
governed field, `ralph-debt.mjs audit`), for a pre-run safety blocker: a risk to the harness or
the repository that any autonomous run would aggravate, not a defect that only some tickets rely
on. Its owner is the `ready-for-human` ticket that removes the risk.

### Transition (TD-059)

The global form, the code that reads it and TD-059's switch from its explicit list land in one
commit, so no commit has a register the gate cannot read or a ticket Ralph can select that is
`clear`. Either mix of versions also stays closed: the old gate refuses the new register as
invalid, and the new gate reads the old explicit list as before. A test asserts that while TD-059
is unresolved the repository's own gate clears no `ready-for-agent` ticket.

## Alternatives considered

- **Keep explicit lists.** Correct only while every ticket-creating commit remembers to extend
  them; the failure mode is silent.
- **A separate stop file or environment switch.** A second mechanism beside the register, outside
  its history and audit, and an environment switch can be forgotten in a shell or a CI setting.
- **Hold every ticket, including `ready-for-human`.** Blocks nothing automated that the narrower
  hold does not, and would make the gate's verdict say the remediation itself may not start.

## Consequences

- A safety stop is one reviewed line in the register, and new tickets cannot slip past it.
- A global hold needs an owner worked by hand; the gate refuses a hold that could never lift.
- Malformed gate data now stops runs loudly instead of looking like an empty queue.
