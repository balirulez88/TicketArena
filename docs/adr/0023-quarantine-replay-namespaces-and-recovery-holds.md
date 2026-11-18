# 0023: Quarantine replay namespaces and recovery holds

- **Status:** Accepted
- **Date:** 2026-11-17
- **Extends:** [0018](0018-host-side-replay-of-a-rejected-candidate.md), [0014](0014-sandbox-trust-boundary.md), [0020](0020-global-fail-closed-debt-hold.md)

## Context

TD-059 moved the host's quarantined rejected work out of `refs/heads/rejected/` into
`refs/ralph/rejected/` (WS1), so a branch push no longer publishes it. Three gaps remained. Replay
(ADR 0018) still read only `rejected/<slug>-<run>` branches, through Git's short-name lookup and a
substring match on the host's record. Rejections from before the move are recorded under their
old branch name, and the maintainer moves those candidates into the new namespace with the same
commits. And a host-review rejection is two steps, quarantine then the blocked-status commit. When
the second fails, the ticket still looks `ready-for-agent`, and the batch reported a
`ralph/blocked-*` side branch that did not exist.

## Decision

`scripts/ralph-quarantine.mjs` is the one place that knows the namespaces. Replay, the importer
and the batch use it, and a human can call it too.

1. **Exact resolution.** A candidate is `refs/ralph/rejected/<s>`, `refs/heads/rejected/<s>`, or
   the alias `rejected/<s>`, which means exactly those two. `<s>` must be
   `<NN-slug>-<yyyymmdd>-<hhmmss>`. Both namespaces are always read; a twin at another commit is
   refused as a conflict. Incoming refs, published remote-tracking copies, other namespaces,
   symbolic refs and refs to non-commits are refused. Git's ambiguous short-name lookup is never
   used.
2. **Provenance.** The host's record must be the importer's whole message, parsed exactly. It
   must name the candidate's slug, the first 12 characters of its commit, and one of the names
   this candidate may carry. For `refs/ralph/rejected/<s>` that is the full ref; for
   `refs/heads/rejected/<s>`, `rejected/<s>`. `--expect` still pins all 40 characters.
3. **Legacy compatibility (D1), and only this.** A record naming `rejected/<s>` also covers
   `refs/ralph/rejected/<s>`: the same suffix, the same commit identity, no conflicting twin. It
   is the maintainer's migration of a pre-WS1 candidate. It cannot cover another suffix, and a
   current record never covers a branch under `refs/heads/`. Replay logs whenever it applies.
4. **Read-only inspection.** `list` and `inspect` label every quarantine ref, legacy branch,
   incoming ref and published copy, with eligibility and security warnings. They use plumbing
   and `--no-ext-diff --no-textconv`, and write no ref, index or working-tree file. Listing an
   incoming ref or a published copy never makes it replayable.
5. **Recovery holds (D2), fail closed.** When the blocked-status commit fails after the
   quarantine, the importer keeps every ref and records `refs/ralph/recovery/<slug>`. That is a
   create-only ref to a blob naming the preserved refs and the reason. The batch places the same
   hold when the base is not blocked but the run left rejection evidence. While any hold exists,
   the importer applies nothing, every batch stops before its first step (`--new` included),
   `sandbox.sh` starts no container and `ralph-loop.sh` selects nothing. An unreadable hold holds.
   Only a human releases it: `release --ticket <slug> --expect <object>`, refused while the ticket
   is still `ready-for-agent` unless `--rerun` is given. No quarantine or incoming ref is touched.
6. **Replay scratch refs.** They are create-only under `refs/ralph/replay/<replay id>/`, and
   replay deletes nothing else, and only at the commit it wrote.

## Consequences

- Rejections recorded before and after WS1 are replayable through the same checks; nothing is
  recreated as a branch to get past them.
- The batch's stop message names only refs that exist. A side branch is mentioned only when one
  does.
- A hold is local to the repository (`refs/ralph/` is never pushed). Another clone or host does
  not see it and would select the ticket from `main` as it stands. If the batch sees the
  rejection (a quarantine ref or a side branch) but neither it nor the importer can write a hold,
  its stop message asks that no run start; nothing enforces that.
- If the quarantine ref, the blocked-status commit and the importer's hold all fail, the run
  leaves only its incoming refs, exactly as an unavailable host review does. The batch cannot tell
  the two apart from the repository and reports `runner-failed`, which is resumable; only the
  importer's `RECOVERY REQUIRED` log says not to resume. Every Git write on the host failing at
  once is the case this does not cover.
- Holds are plain refs to a blob, created only by `scripts/ralph-quarantine.mjs`. A hold whose
  object is missing, or that Git warns about, counts as held. A dangling symbolic ref under
  `refs/ralph/recovery/` is skipped by Git without a warning and is not detected; nothing here
  creates one.
- A failing hook or lock on the host stops all automated work until a human reconciles it. That
  is intended: the alternative is running a rejected ticket again unnoticed.
