# 53: Risk-based technical debt gate

**What to build:** deferred review findings carry a human-triaged risk class, an owner ticket and
the tickets they block; the host holds exactly the tickets that rely on unresolved or untriaged
debt, refuses an owner ticket's merge until its debt is resolved with test evidence in the
candidate's own tree, and refuses any change a slice makes to triage. ADR 0016.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-06 by harness/53-risk-based-debt-gate (reviewed by independent host-side Standards and Spec reviewers and merged outside Ralph: a sandboxed agent must not author its own trust boundary)

- [x] Risk class, triage, owner and blocking are separate fields; validation rules for each,
  including `ACCEPTED_RISK` acceptance criteria and test-file-only verification evidence.
- [x] The debt gate (`clear`, `waiting`, `needs-triage`) in selection, the batch (exit 4,
  resumable) and the host importer; independent tickets proceed past unrelated `LOW` debt.
- [x] The importer refuses unauthorized severity, risk, triage, target, status, blocking and
  acceptance changes, and an owner ticket that leaves its debt unresolved.
- [x] Maintainer changes are audited in CI (`ralph-debt.mjs audit`).
- [x] Initial triage of every unresolved entry; tickets 49–52 created for unowned debt; ticket 12
  owns TD-016, TD-018, TD-020, TD-067 and TD-071.
