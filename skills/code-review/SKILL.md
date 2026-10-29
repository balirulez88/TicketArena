---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
---

<!-- Vendored from mattpocock/skills@7739eae skills/engineering/code-review/SKILL.md (MIT). Local, project-agnostic extensions are marked [local]; see README.md in this directory. -->

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings. Start every sub-agent with a fresh context window.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

> **[local]** If no tracker was configured, do not stop: find specs and tickets as described in
> step 2 and in [Project discovery](#local-project-discovery). Sub-agents only read; neither they
> nor this skill modify, stage or commit anything.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside two parallel sub-agents.

> **[local]** Review the complete candidate changeset, not only commits. If the working tree is
> dirty, the changeset is `git diff $(git merge-base <fixed-point> HEAD)` (staged and unstaged)
> **plus** every untracked file from `git ls-files --others --exclude-standard`, read in full.
> Give sub-agents that combined description so new files are never missed.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in the tracker doc.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

> **[local]** Also follow links: a ticket usually names its parent spec and ADRs. Give the Spec
> sub-agent the ticket **and** what it references. Local ticket files (e.g. `issues/*.md`) count
> as issues.

### 3. Identify the standards sources

Search the repo for every file that documents how code should be written. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list.

> **[local]** Agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`
> and the like), architecture decision records (`docs/adr/`, `adr/`, `docs/decisions/`), glossaries
> and any document they point to for review guidance are standards sources too. See
> [Project discovery](#local-project-discovery) for the stack and tooling.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

> **[local]** The Standards axis also carries the **risk baseline**: problems a passing linter,
> type checker and test suite can still hide. Check each one only where the diff touches it:
>
> - **Correctness under concurrency**: transaction boundaries, lock scope and ordering, races,
>   check-then-act on shared state, time read before a lock is held.
> - **Idempotency and consistency**: retried or duplicated requests and messages, exactly-once
>   claims, writes that must happen together but are not atomic, dual writes without an outbox.
> - **Messaging reliability**: acknowledgement after side effects, redelivery, ordering
>   assumptions, poison messages, recovery after a crash.
> - **Security**: authentication and authorization on every entry point, validation of external
>   input at the boundary, injection, secrets in code or logs, unsafe defaults.
> - **Failure handling**: swallowed errors, retries without bounds or backoff, partial failure
>   left inconsistent, error messages that hide the cause.
> - **Test quality**: tests that cannot fail, assert implementation instead of behaviour, mock
>   the unit under test or skip the risky path the change introduces.
> - **Design**: cohesion, responsibilities, dependency direction and injection, encapsulation,
>   abstraction that the need does not justify (KISS over SOLID-for-its-own-sake), avoidable
>   duplication, needless performance overhead.
>
> Unlike baseline smells, a risk with a concrete failure scenario is a hard finding.

### 4. Spawn both sub-agents in parallel

Issue both sub-agent calls together, in the foreground, and aggregate the reports they return.

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

> **[local]** Also paste the **risk baseline** and the stack summary from
> [Project discovery](#local-project-discovery), and extend the brief with "(c) every risk-baseline
> problem, with the concrete failure scenario". Ask for findings in the
> [finding format](#local-severity-and-finding-format).

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

> **[local]** Also ask: "(d) acceptance criteria whose tests do not actually prove them". Ask for
> findings in the [finding format](#local-severity-and-finding-format).

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

> **[local]** Within each axis, order findings by severity. The summary line names the count per
> severity per axis. Severities describe risk; whether any of them blocks a merge is the
> caller's policy, not this skill's.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

## [local] Project discovery

The skill holds no project knowledge. Before step 4, learn the project from the repository:

- **Stack and versions**: manifests and lockfiles (`package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, `pom.xml`, `Gemfile`, ...), runtime pins (`.nvmrc`, `.tool-versions`, Dockerfiles),
  framework configs. Note the exact major versions in use.
- **Enforced tooling**: linter, formatter, type checker and test configs, plus CI workflows.
  Whatever they enforce is out of scope; do not repeat it.
- **Architecture**: ADRs and architecture docs. An accepted decision is a standard; code that
  contradicts it is a finding, and so is a review suggestion that would.

Apply framework and language best practices **only for what the project uses, at the versions it
uses**: flag APIs deprecated or discouraged in that version, and idioms the project's own docs
reject. Newer is not automatically better: prefer the stable, simple, well-supported option the
project already chose, and never recommend a new dependency or framework without a concrete
technical reason tied to a finding.

## [local] Severity and finding format

Every finding names the affected code (`file` and `line`), the rule or spec line it rests on,
the problem, its impact and a recommended correction. Severity:

| Severity   | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `CRITICAL` | Severe security, correctness or data-integrity failure                          |
| `HIGH`     | Significant correctness, architectural, reliability or maintainability problem |
| `MEDIUM`   | Meaningful improvement without immediate serious risk                           |
| `LOW`      | Minor suggestion or stylistic improvement                                       |

Calibrate honestly. Baseline smells and stylistic preferences are at most `MEDIUM` unless the
impact names a concrete failure. `CRITICAL` and `HIGH` need a concrete failure scenario. Prefer
no finding over a speculative one; an empty list is a valid result.

## [local] Non-interactive mode

A harness (CI job, autonomous loop) may run the two sub-agents itself, each as a separate,
fresh, read-only agent process, instead of asking this skill to spawn them. Each process is told
its axis, the fixed point, the changeset, the spec (Spec axis) and a JSON schema. In that mode:

- Do steps 2, 3 and [Project discovery](#local-project-discovery) yourself for your axis; you
  are the sub-agent from step 4, so the brief for your axis applies.
- Do not modify any file and do not ask questions: there is nobody to answer.
- Return one report matching [`report.schema.json`](report.schema.json): `axis`, `status`
  (`reviewed`, or `skipped` only when the Spec axis truly has no spec), `summary` and `findings`.
  The 400-word limit is replaced by the schema; keep each field short and specific.
