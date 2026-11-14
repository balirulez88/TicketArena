# Ralph Control Center

A read-only local dashboard over the Ralph workflow. It shows tickets, their statuses and
dependencies, current runs and agent phases, review outcomes, technical-debt blockers and recent
failures. Everything comes from the repository and `.ralph/` artifacts. It never writes a file,
never runs a mutating Git command, and never starts, stops or steers Ralph.

## Start it

```bash
pnpm install                 # once, links the workspace package
pnpm control-center          # http://127.0.0.1:4319/
pnpm control-center -- --port 5000 --ref main --stale-after 10 --refresh 0
```

Run it from any checkout or linked worktree. By default it reads the **main checkout** (the
parent of Git's common directory), because `.ralph/` exists only where Ralph runs.

| Flag            | Environment variable           | Default       | Meaning                                                     |
| --------------- | ------------------------------ | ------------- | ----------------------------------------------------------- |
| `--root`        | `RALPH_CC_ROOT`                | main checkout | Repository whose `issues/`, register and `.ralph/` are read |
| `--ref`         | `RALPH_CC_REF`                 | `main`        | Ref the tickets and register are read from                  |
| `--host`        | `RALPH_CC_HOST`                | `127.0.0.1`   | Loopback only (`127.0.0.1`, `::1`, `localhost`)             |
| `--port`        | `RALPH_CC_PORT`                | `4319`        |                                                             |
| `--stale-after` | `RALPH_CC_STALE_AFTER_MINUTES` | `15`          | Quiet time after which an `active` run is stale             |
| `--refresh`     | `RALPH_CC_REFRESH_SECONDS`     | `30`          | Page auto-refresh; `0` turns it off                         |

`GET /` serves the page, `GET /api/state` the same state as JSON and `GET /assets/dashboard.js`
the page's script. Every other method gets 405.

## Views

| View           | Shows                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Overview       | Ticket KPIs, execution status (live / stale / idle), latest run, debt blockers, recent activity, gaps   |
| Ticket Board   | One column per status line, cards with blockers, calculated eligibility, phase; search and filters      |
| Agent Activity | Planning → Implementation → Testing → Review → Merge per run and ticket, with a session timeline        |
| Technical Debt | Open / planned / resolved counts, severity distribution, held tickets, findings ranked by actionability |
| Run History    | Every run with duration, outcome, review verdicts, rejection reasons and failures, expandable           |

Ticket cards and debt findings open a detail drawer. The server renders and escapes all markup;
the script (`src/client/dashboard.ts`, transpiled once at start-up with the already-installed
TypeScript compiler) only switches views, filters, opens details and refreshes. Every
`--refresh` seconds it re-reads `/` and swaps the marked regions in place, keeping the view,
filters, open details and drawer; it pauses while the tab is hidden, text is selected, or the
reader pressed Pause. Without JavaScript all views are shown in sequence and a `<noscript>` meta
refresh reloads the page. The CSP allows only this origin's script and fetches
(`script-src 'self'; connect-src 'self'`), no inline script.

Pipeline stages come only from recorded evidence: `red` → Testing; `green`, `refactor`, `docs` →
Implementation; `review-spec`, `review-standards`, `review-fix` → Review; a ticket's
`**Completed:**` line naming the run → Merge (a rejecting host review → failed). Ralph writes no
planning record and a Lead session spans every stage, so those stay "no evidence"; a Lead session
is listed as unmapped. A stage is active only in a live run; a `running` session in a quiet run
is stale.

## Where each value comes from

| Shown                   | Source                                                                                                                                           | Label                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Ticket status, blockers | `issues/*.md`, `issues/done/*.md` **at the ref's commit** (`git ls-tree`/`cat-file`), not the working tree                                       | live                    |
| Debt gate verdicts      | `docs/technical-debt.md` at the ref, through `scripts/ralph-debt.mjs` `debtGate` (Ralph's own code)                                              | live                    |
| Selectable              | Ralph's selection rule: `ready-for-agent`, all blockers `done`, debt gate `clear`                                                                | derived                 |
| Runs, agent phase       | `.ralph/logs/<run>/run.json`, `sessions.tsv`, `sessions/*.tsv`; runs still inside `.ralph/sandbox/<id>/out/logs/`                                | live / stale / finished |
| Review outcomes         | `<slug>.review-<N>.decision.json` (loop) and `.ralph/host-review/<id>/<slug>/decision.json` (host)                                               | historical              |
| Batch, lock, pauses     | `.ralph/batch/state.json`, `.ralph/batch/lock/owner.json`, `.ralph/state/*.pause`                                                                | live / historical       |
| Failures                | failed/timed-out/interrupted sessions, failed/paused runs, non-zero `.ralph/sandbox/*/verdict.json`, `rejected/*` branches, abnormal batch stops | historical              |
| Unavailable sources     | anything missing or unparseable, with the reason                                                                                                 | unavailable             |

## What it will not claim

- **A ticket status is never inferred.** The `**Status:**` line is shown verbatim, even while a
  live run works on the ticket. An unknown value is flagged as unrecognized, not mapped.
- **Live means active and recently written.** A run is `live` only while `run.json` says `active`
  and its directory changed within `--stale-after`. Otherwise it is `stale: claims active`: a
  killed run stays `active` forever, and sandbox containers are unnamed, so process liveness
  cannot be verified. The same goes for the batch lock holder.
- **A batch is live only with its lock.** `ralph-batch.mjs` leaves a resumable batch `running`.
- **Logs expire.** `.ralph/logs` is kept 30 days, so older tickets show "no run logs" or "none on
  record" rather than a guessed history.
- **A failed read is not an empty one.** "none", "0", "Idle" and "Quiet" appear only when every
  source behind them was read. Without `.ralph/`, or when a directory cannot be listed, a file
  cannot be read or parsed, a host review has no `decision.json` yet, or Git cannot list the
  branches, the value is shown as `UNAVAILABLE` with the reason. The execution status becomes
  "Run state unknown", with the reason, unless a live run was found, when the run list is
  incomplete, when an `active` run's files cannot all be listed, when a run's `run.json` exists but
  cannot be read or parsed (it is rewritten in place, so a refresh can catch it truncated), or when
  a run without `run.json` was written within `--stale-after` or could not be fully listed. A fully
  listed run without `run.json`, quiet for longer, cannot be the live one.
- **Only loopback names are answered.** A request whose `Host` is not `127.0.0.1`, `localhost` or
  `[::1]` on the served port gets `421`, so a DNS-rebinding page cannot read the state.
- **One commit per refresh.** The ref is resolved once (`git rev-parse --verify`), and tickets and
  the register are read from that commit, so a ref that moves mid-refresh cannot mix two versions.
  A ref Git cannot resolve is "not found when read" (it may also have been rewritten at that
  moment); any other Git failure is shown with Git's own message. Nothing is retried: the next
  refresh reads again.

## Tests

`pnpm --filter @ticketarena/control-center test` covers the parsers, the state mapping (liveness,
selectability, debt verdicts, failures), the presentation rules (eligibility, board grouping,
pipeline stages, durations, debt ranking), the client's navigation, filter and refresh decisions,
the HTML escaping and the absence of inline script, the GET-only server and its CSP, configuration,
and an integration test on a real temporary Git repository. That test proves reads come from the
ref, ignore an inherited `GIT_DIR`, and leave the repository (including `.git`) byte-for-byte
unchanged. It also covers Git failures (a missing ref, a permission error and a transient failure,
through an injected Git runner) and a ref that moves mid-snapshot. `availability.test.ts` covers
each unavailable source end to end, from snapshot to page; `style.test.ts` guards the grid tracks
against page-wide horizontal overflow; `client/dashboard-dom.test.ts` covers view switching and
drawer focus against a minimal stand-in DOM.
