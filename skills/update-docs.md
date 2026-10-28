---
name: update-docs
description: Update the hierarchical architecture docs in /docs after a vertical slice goes green. Use after every green slice, before the slice is committed.
---

<!-- TicketArena-native skill (not vendored). -->

`/docs` is the system's **persistent architectural memory**: the next agent starts with a fresh
context window and knows only what the code and these maps say. A slice that changes the system
without updating its map leaves the next agent working from a wrong picture, so this step is
part of the slice, not optional cleanup.

## When

After the slice's quality gate (`pnpm run lint`, `pnpm run typecheck`, `pnpm run test`) is
green and **before** it is committed, so the code and its map land in the same atomic commit.

## Process

1. **Diff the slice.** List what changed (`git diff --stat` against the base branch, plus
   untracked files). Classify each change by the docs area it touches:

   | Change touches                                       | Update                       |
   | ---------------------------------------------------- | ---------------------------- |
   | new/renamed package, app, or module boundary         | `docs/architecture/index.md` |
   | Prisma schema, migration, index, transaction pattern | `docs/database/index.md`     |
   | outbox event type, broker subject, consumer          | `docs/messaging/index.md`    |
   | Redis keys, queue admission, rate limits             | `docs/architecture/waiting-room.md` (create on first use) |
   | harness, skills, quality gate                        | `docs/workflow/index.md`     |
   | a new domain term                                    | `docs/glossary.md`           |
   | a hard-to-reverse decision with real alternatives    | new ADR in `docs/adr/`       |

2. **Update the leaf docs first, then the indexes.** Each `index.md` summarises its children,
   and `docs/index.md` summarises the areas. Propagate upward only what changes the picture at
   that level: the root map should stay readable in two minutes.

3. **Describe the system as it IS.** Docs state current behaviour and the reason for it. Move
   items out of "Open decisions" once the slice settled them, and remove "planned" wording for
   anything now built. History belongs in git and ADRs, not in the maps.

4. **Keep docs free of volatile detail.** Name modules, contracts, invariants and data flows,
   not line numbers or code snippets that will rot. Link to the code path when a reader needs it.

5. **Record decisions as ADRs** using `docs/adr/0000-template.md`, numbered sequentially, and
   add them to `docs/adr/index.md`. Never edit an accepted ADR's decision; supersede it.

6. **Close the ticket.** Tick the acceptance-criteria boxes that are now met in the ticket file.
   (Under `ralph-loop.sh` the harness flips `**Status:**` to `done`; do not do it yourself.)

7. **Re-run `pnpm run lint`.** Docs edits must not break the gate.

## Done when

Someone reading only `docs/index.md` and the area index for this slice could correctly explain
what the slice added and why, without opening the code.
