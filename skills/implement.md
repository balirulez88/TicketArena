---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

<!-- Vendored from mattpocock/skills@59db609 skills/engineering/implement/SKILL.md (MIT). See skills/README.md. -->

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "code-review" to review the work.

Commit your work to the current branch.

> **[local]** Project overrides:
>
> - The quality gate is `pnpm run lint` (Biome, warnings are errors), `pnpm run typecheck`
>   and `pnpm run test`. Run `pnpm run format` before declaring done; never weaken
>   `biome.json` or add `biome-ignore` comments to get green.
> - After the slice is green, call the Skill tool with "update-docs".
> - When running under `ralph-loop.sh` (env `RALPH_TICKET` is set), the harness owns git:
>   **do not commit, branch, stash or push**. It commits the slice itself only after the gate
>   passes. Outside the harness, commit as above using Conventional Commits.
