# Skills

The agent workflow for TicketArena. Each skill is a plain Markdown instruction file. Claude Code
picks them up through thin wrappers in `.claude/skills/<name>/SKILL.md` that point back here, so
this directory is the single source of truth and stays readable for any agent or human.

## Workflow

```text
/grill-me ──► /to-spec ──► /to-tickets ──► ralph-loop.sh (per ticket: /implement + /tdd ──► /update-docs)
 decisions     docs/specs/    issues/NN-*.md   red → green → refactor, gated by Biome + tsc + Vitest
```

| Skill            | Role                                                                 | Origin  |
| ---------------- | -------------------------------------------------------------------- | ------- |
| `grill-me.md`    | Entry point for the design interview; delegates to `grilling`        | vendored |
| `grilling.md`    | Design-tree interview, asked in frontier rounds                      | vendored |
| `to-spec.md`     | Synthesises the conversation into a spec (PRD)                       | vendored |
| `to-tickets.md`  | Splits a spec into tracer-bullet tickets with blocking edges         | vendored |
| `implement.md`   | Implements a ticket via TDD, then code review                        | vendored |
| `tdd.md` (+ `tdd-tests.md`, `tdd-mocking.md`) | Red → green rules, seams, anti-patterns | vendored |
| `update-docs.md` | Keeps the `/docs` architecture maps current after each green slice   | native  |

## Provenance

Vendored files are copied from [mattpocock/skills](https://github.com/mattpocock/skills) at
commit `59db609eb1e18aaf59b63284d0e52255aff0c63c` under the MIT License (see
[`UPSTREAM-LICENSE`](UPSTREAM-LICENSE)). Each file names its upstream path in a header comment.

Upstream text is kept verbatim. Every local deviation is marked **[local]** inline, so a diff
against upstream shows only these intentional changes:

- **Tracker:** upstream asks `/setup-matt-pocock-skills` to configure an issue tracker. Here it is
  fixed: specs go to `docs/specs/`, tickets to `issues/<NN>-<slug>.md` (flat, globally
  numbered) because `ralph-loop.sh` consumes that directory.
- **Glossary & ADRs:** `GLOSSARY.md` → `docs/glossary.md`, ADRs → `docs/adr/`.
- **Git ownership:** inside the harness, `implement` must not commit; the harness commits only
  slices that pass the gate.
- **Unattended seams:** under the harness, the seams agreed in the spec count as confirmed.
- **Docs step:** `implement` ends with `update-docs`.

`skills/` and `.claude/skills/` are excluded from Biome so the formatter never rewrites
vendored text and the upstream diff stays clean.

To upgrade, diff the upstream files at a newer commit against these, re-apply the **[local]**
notes, and update the commit hash above.
