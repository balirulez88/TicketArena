# code-review (portable)

Two-axis code review, **Standards** and **Spec**, run as two independent sub-agents whose reports
stay separate. Vendored from
[mattpocock/skills](https://github.com/mattpocock/skills/tree/7739eaed7f8f3915437a8def198a6d0d7206dbc7/skills/engineering/code-review)
at commit `7739eae` (MIT, see [`../UPSTREAM-LICENSE`](../UPSTREAM-LICENSE)).

This directory is **project-agnostic**: no file here names a project, framework or tool chain. The
skill discovers the stack, standards, ADRs and specs of whatever repository it runs in.

## Files

| File                 | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `SKILL.md`           | Upstream skill verbatim, plus generic **[local]** extensions        |
| `report.schema.json` | One axis's report, for non-interactive (harness) use. JSON Schema draft-07: Claude Code's `--json-schema` rejects draft 2020-12 |
| `agents/openai.yaml` | Upstream display metadata, unchanged                               |

## Local extensions (all generic)

Each is marked **[local]** in `SKILL.md`, so a diff against upstream shows only these:

- Works without a configured tracker; follows ticket links to specs and ADRs.
- Reviews the complete candidate changeset: committed, staged, unstaged **and** untracked files.
- Treats agent instruction files and ADRs as standards sources.
- **Project discovery**: stack and versions from manifests, enforced tooling (not re-checked),
  version-appropriate framework practice only for what the project uses; no new dependencies
  without a concrete reason.
- **Risk baseline** on the Standards axis: concurrency, idempotency, messaging, security,
  failure handling, test quality, design.
- **Severity** (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) with a required finding format: file and
  line, rule, problem, impact, recommendation. Which severities block a merge is left to the
  caller.
- **Non-interactive mode**: a harness can run each axis as its own fresh, read-only agent that
  returns JSON matching `report.schema.json`.

## Install in another repository

1. Copy this directory to `.claude/skills/code-review/` (Claude Code) or wherever your agent
   loads skills from. Nothing else is required: no scripts, services or files from this repo.
2. Optional: write down what reviewers should know: coding standards in `CONTRIBUTING.md`,
   `CODING_STANDARDS.md` or `CLAUDE.md`/`AGENTS.md`, decisions in `docs/adr/`. The skill finds them.

Claude Code also ships a built-in `code-review` skill. A project skill of the same name takes its
place in that project's session (check the skill list: the description should start with "Review
the changes since a fixed point"). To keep both, rename this directory and its `name:` field,
e.g. to `two-axis-review`.

## Use

Interactive: `/code-review main` (or any fixed point). The skill pins the changeset, finds the
spec and standards, runs both sub-agents in parallel and prints `## Standards` and `## Spec`.

Non-interactive, one process per axis (shown for Claude Code; any agent CLI with read-only tools
and schema-checked output works):

```bash
claude -p --restricted --strict-mcp-config --tools=Read,Grep,Glob \
  --output-format=json --json-schema "$(cat .claude/skills/code-review/report.schema.json)" \
  "Act as the Standards sub-agent of .claude/skills/code-review/SKILL.md in non-interactive mode.
   Fixed point: main. Changeset: git diff main...HEAD (saved in review.diff)."
```

The report is in the result's `structured_output`. Treat a failed run, an error result or an
invalid report as a failed review, never as an approval.
