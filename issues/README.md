# Issues (local tracker)

One file per ticket, written by `/to-tickets` and consumed by `ralph-loop.sh`.

## File contract

The harness parses these files, so the format is strict:

- **Name:** `NN-kebab-slug.md`. `NN` is a global, zero-padded, two-digit number in dependency
  order (blockers first). Continue from the highest existing number in `issues/` **and**
  `issues/done/`: a number names exactly one ticket, forever.
- **Title line:** `# NN: Ticket title`. It becomes the commit subject.
- **Blockers:** exactly one line `**Blocked by:** None (can start immediately)` or
  `**Blocked by:** 03, 04` (two-digit numbers; titles may follow in parentheses).
- **Status:** exactly one line `**Status:** <value>`.

| Status            | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `ready-for-agent` | Approved; the harness may pick it up once its blockers are `done` |
| `in-progress`     | Claimed by a running harness                                      |
| `done`            | Merged as a green slice; archived in `issues/done/`               |
| `blocked`         | The harness rejected it; needs a human (see `rejected/*` branch)  |

## Lifecycle

`issues/` is the active queue: the harness picks tickets only from here. When a slice passes
review and the final gate, the harness marks its ticket `done`, adds
`**Completed:** <date> by slice/<NN>-<slug> (run <run-id>)` and moves it to `issues/done/`, all
in the slice's own commit. Archived tickets are never picked again. They still satisfy
`**Blocked by:**` references and remain the audit record, so never delete them. Rejected and
interrupted tickets stay here.

Size a ticket for one fresh agent session per phase: the harness never compacts or carries
conversation between sessions. A ticket whose agents keep running out of context is rejected
with that diagnosis; split it into smaller tickets.

## Template

```markdown
# NN: <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```
