# 0024: The frozen debt register is checked for changes, not audited for ticket links

- **Status:** Accepted
- **Date:** 2026-11-22
- **Supersedes:** [0016](0016-risk-based-debt-gate.md) and [0020](0020-global-fail-closed-debt-hold.md) in part: their blocking rules and the CI audit

## Context

`docs/technical-debt.md` was frozen when devflow replaced harness v1 (`CLAUDE.md`, tag
`harness-v1`): it records harness-v1 findings, no run updates it, and new follow-ups live in commit
messages. CI still ran `ralph-debt.mjs audit` (ADR 0016), and that audit enforces live links
between entries and tickets, for example that an unresolved entry may not block a `done` ticket.
devflow does not read the register, so ticket 21 shipped while TD-062 and TD-065 still listed it
under `Blocks`, and PR #15 went red. Tickets 24, 25, 27 and 38 are listed the same way and would
fail the same way. A frozen record cannot obey rules that require someone to keep it current.

## Decision

- CI checks that `docs/technical-debt.md` is byte for byte the register of the push's or pull
  request's base. Any change fails the build; changing the register needs a superseding ADR.
- The register's `Blocks`, holds and triage no longer gate tickets. Where an entry still names a
  real risk, a human turns it into ticket work, as ticket 50 does for TD-062 and TD-065.
- `scripts/ralph-debt.mjs` stays frozen with the rest of harness v1 and is left unchanged; only
  the CI step that called it changes.

## Consequences

- A stale `Blocks` line no longer turns CI red, and entries are never closed just to satisfy the
  audit: an entry is resolved only by the work that resolves it.
- The register no longer stops a ticket that its entries warn about. The review of each ticket
  and its commit-message follow-ups are now the only places that catch such a risk.
