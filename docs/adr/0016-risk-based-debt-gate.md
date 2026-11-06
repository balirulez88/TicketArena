# 0016: Risk-based technical debt gate

- **Status:** Accepted
- **Date:** 2026-11-06
- **Extends:** [0014](0014-sandbox-trust-boundary.md), [0015](0015-review-and-verification-isolation.md)

## Context

Every deferred `MEDIUM` and `LOW` review finding lands in the
[technical debt register](../technical-debt.md). Until now the register only recorded debt; it
never held work back. Three gaps followed from that:

- **Nothing decided which debt matters to which ticket.** A deferred finding about a guarantee a
  later ticket relies on (a lock order, a retry, a test that proves it) did not stop that ticket.
  Stopping every batch on every new finding would stall unrelated work just as badly.
- **Ownership was optional.** A `PLANNED` entry could name a ticket that never fixed it, and
  the ticket could merge with its debt still open.
- **The agent could edit the register.** A slice's diff could change an entry's severity, its
  target or its status, and the host only checked that the register stayed well-formed.

Severity alone is not the answer. A `LOW` finding in a concurrency test can matter more to the
next ticket than a `MEDIUM` naming convention. Risk class and blocking are separate decisions, and
a human makes both.

## Decision

### Fields

Each entry gains four fields, owned by `scripts/ralph-debt.mjs`:

| Field        | Values                                                                                                     | Who sets it                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Risk`       | `CORRECTNESS`, `CONCURRENCY`, `SECURITY`, `VERIFICATION`, `OPERABILITY`, `MAINTAINABILITY`, or `UNTRIAGED` | human triage (the recorder sets `SECURITY` for a security finding, `UNTRIAGED` otherwise) |
| `Triage`     | `pending`, or `YYYY-MM-DD: <who decided, and where>`                                                       | human triage                                                                              |
| `Blocks`     | `none`, or the two-digit tickets that may not start until the entry is resolved                            | human triage                                                                              |
| `Acceptance` | for `ACCEPTED_RISK` only: `Residual risk:`, `Review when:`, `Decided by:`                                  | human decision                                                                            |

`Target` (`ticket NN …`) is the **owner**: the ticket that must resolve the entry before it can
merge. The recorder may suggest a risk class from the finding's kind in the history line
("suggested risk X, awaiting triage"); it never sets one except for `security`, and it never
triages.

### Triage rules (validated on every register check)

- A triaged entry has a risk class other than `UNTRIAGED`.
- A triaged unresolved `CRITICAL`, `HIGH` or `MEDIUM` entry has an owner ticket.
- Only an entry with an owner may block tickets, and never its own owner. A new entry blocks
  nothing; an entry sent back to triage keeps its `Blocks`, and those tickets need triage.
- `ACCEPTED_RISK` is a deliberate human decision: triaged, blocking nothing, with all three
  `Acceptance` parts. It is never a default.
- Unresolved debt may not name a ticket that does not exist, or that is done (reconcile it), in
  `Target` or `Blocks`. Ticket blockers plus debt edges (a blocked ticket waits on the owner)
  form no cycle among unfinished tickets.
- `RESOLVED` evidence: every backticked path in `Verification` exists and is a test file the gate
  runs (`*.test.{ts,tsx,js,mjs,cjs,sh}`). The host checks this in the candidate commit's own tree.

### The gate (`debtGate`)

For every unfinished ticket the host computes one verdict from the base's register and tickets:

| Verdict        | When                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs-triage` | an unresolved `MEDIUM` or worse entry is untriaged or unowned (every ticket); or an untriaged `LOW` entry was found by a ticket this one builds on (transitively, `Blocked by`), or this ticket owns it, or it came from outside any ticket's review (every ticket); or an entry sent back to triage still lists this ticket in `Blocks` |
| `waiting`      | a triaged unresolved entry lists this ticket in `Blocks`                                                                                                                                                                                                                                                                                 |
| `clear`        | otherwise                                                                                                                                                                                                                                                                                                                                |

So: `CRITICAL` and `HIGH` still block the merge itself, unchanged. An untriaged `MEDIUM` holds all
work until someone classifies it and names an owner, because nobody yet knows what it affects. An
untriaged `LOW` holds only the tickets that build on the work it was found in (every ticket, if
no ticket's review found it); an independent ticket proceeds. A triaged `LOW` holds nothing unless a human listed tickets in `Blocks`, which
is how a `LOW` in a correctness, concurrency, security or verification guarantee becomes a
dependency of exactly the tickets that rely on it. An untriaged finding is never assumed safe for
a ticket that depends on it.

### Enforcement

- **Selection** (`ralph-loop.sh` `next_ticket`): picks the first ticket the gate clears. A
  `waiting` or `needs-triage` ticket never runs; independent, cleared tickets after it still do.
  `triage_ticket` reports the first ticket that needs triage.
- **Batch** (`scripts/ralph-batch.mjs`): stops `needs-triage` (resumable, exit 4) when no cleared
  ticket is left and one needs triage, and re-checks a paused ticket's verdict before resuming it
  (`waiting` stops it as `unresolved-dependency`, untriaged risk as `needs-triage`). An invalid
  register clears nothing.
- **Importer** (`scripts/ralph-accept.mjs`, the trust boundary): refuses (exit 3) a ticket whose
  verdict on the base is not `clear`, and a slice whose register breaks the slice rules:
  - a slice may resolve entries (with evidence in its own tree) and the host's recorder may add
    `OPEN`/`pending` entries, reopen a reported-again entry (discarding its triage), or send an
    entry back to triage on a higher-severity sighting, with that history line (it keeps its
    owner and `Blocks`, so the tickets it blocked now need triage);
  - nothing else may change: the rules preamble, entries' titles, history prefixes, fingerprints,
    severity, risk, triage, target, blocks, acceptance, justification, descriptions;
  - every entry the base says the ticket owns must be `RESOLVED` by the slice;
  - the register must be in canonical form, as `check:debt` requires.
- **Maintainers** change triage in ordinary reviewed commits on `main`. `ralph-debt.mjs audit`
  (run by CI against the push's or pull request's base) requires a new history line for every
  changed governed field, and refuses removed entries or rewritten history.

The rules live in the base's `scripts/ralph-debt.mjs`, which the importer already runs from the
host; a slice cannot change the code that judges it (ADR 0014).

### Harness tickets

Ticket status `ready-for-human` marks work Ralph never selects: changes to the trust boundary are
reviewed and merged by a human with host-side reviewers (ticket 52).

## Alternatives considered

- **Severity alone decides.** Simple, but it blocks unrelated work on a `MEDIUM` style issue and
  lets a `LOW` gap in a concurrency proof through to the ticket that depends on it.
- **Automatic risk mapping from review categories.** Reviewer categories are ambiguous
  (`test-coverage` may be cosmetic or may be the only proof of an invariant). A suggestion in
  the history keeps the hint without trusting it.
- **Stopping the batch on every new blocking-class finding.** Safe, but it turns each review into
  a full stop for independent tickets. Dependency-aware verdicts stop exactly the tickets at risk.
- **Letting the agent triage its own findings.** The agent is the adversary of ADR 0014; triage is
  a decision about what it may skip.

## Consequences

- Every unresolved entry carries a risk class, an owner where needed and a dated triage line; the
  register's summary adds a risk × status table.
- A finding that a later ticket relies on is fixed by its owner first; the owner cannot merge
  without resolving it.
- New review findings may pause dependent tickets until a maintainer triages them; independent
  tickets continue.
- The initial triage (ticket 53) classified all 66 unresolved entries and created tickets 49–52
  for debt without an owner.
