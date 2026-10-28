# Agent Workflow & Quality Gate

[← System map](../index.md)

## Pipeline

| Step | Skill / tool                   | Output                              |
| ---- | ------------------------------ | ----------------------------------- |
| 1    | `/grill-me` (→ `grilling`)     | Shared understanding, decisions     |
| 2    | `/to-spec`                     | `docs/specs/<feature>.md`           |
| 3    | `/to-tickets`                  | `issues/<NN>-<slug>.md`             |
| 4    | `ralph-loop.sh` (in sandbox)   | One green, atomic commit per ticket |
| 5    | `/update-docs` (inside step 4) | Updated `/docs` maps                |

Skill sources and provenance: [`skills/README.md`](../../skills/README.md).

## Quality gate

`pnpm run check` = `lint` → `typecheck` → `test`. All three must pass with zero warnings:

- **Biome** (`biome ci --error-on-warnings`): lint, formatting, import order. A warning is a
  failure. Fix with `pnpm run format`; never by loosening `biome.json` or `biome-ignore`.
  Excluded: vendored `skills/` (kept verbatim to upstream), generated code, `pnpm-lock.yaml`.
  The one disabled rule, `useLiteralKeys`, contradicts TypeScript's
  `noPropertyAccessFromIndexSignature`, which deliberately forces `process.env["X"]` so that
  unvalidated env access stands out.
- **TypeScript** strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`.
- **Vitest** behaviour tests at agreed seams.

## Ralph loop (`ralph-loop.sh`)

For each ticket whose `**Status:**` is `ready-for-agent` and whose blockers are all `done`:

1. Create branch `slice/<NN>-<slug>` from `main`.
2. **RED:** the agent writes failing test(s) for the first acceptance criterion. The harness
   requires a changed test file, lint passing, and `pnpm run test` **failing**. A test that
   passes before any implementation proves nothing and is rejected.
3. **GREEN:** the agent implements until the full gate passes. Gate output from a failed attempt
   is fed into the next one, up to `RALPH_MAX_ATTEMPTS`.
4. **REFACTOR + DOCS:** the agent runs the code-review/refactor pass and `update-docs`. The gate
   must stay green. If it does not, the refactor is discarded and the green state kept.
5. Squash into **one** Conventional Commit, mark the ticket `done` in the same commit, merge
   `--no-ff` into `main` so dependent tickets build on it, and optionally push.

A ticket that cannot get through RED, GREEN or DOCS is **rejected**: its failing work is
committed to a quarantine branch `rejected/<NN>-<slug>-<run-id>` (never to a slice branch or
`main`), the ticket is marked `blocked` on `main`, and the loop stops for a human to look.
Agent transcripts and gate output are kept in `.ralph/logs/<run-id>/` (git-ignored).

## Sandbox

`Dockerfile` defines a Node 24 + pnpm + git + Claude Code image. `scripts/sandbox.sh` builds it
and runs the loop against a **clone** of the repo inside the container. The agent therefore
never touches the host working tree, and host-native `node_modules` (e.g. Windows binaries)
never mix with Linux ones. Green results are pushed back to the host repo's branches.
The agent runs with permission prompts disabled **only** inside the container
(`RALPH_SANDBOX=1`); the script refuses to do so elsewhere unless explicitly overridden.
