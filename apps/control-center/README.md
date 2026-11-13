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

`GET /` serves the page and `GET /api/state` the same state as JSON. Every other method gets 405.

## Where each value comes from

| Shown                   | Source                                                                                                                                           | Label                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Ticket status, blockers | `issues/*.md`, `issues/done/*.md` **at the ref** (`git ls-tree`/`cat-file`), not the working tree                                                | live                    |
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

## Tests

`pnpm --filter @ticketarena/control-center test` covers the parsers, the state mapping (liveness,
selectability, debt verdicts, failures), the HTML escaping, the GET-only server, configuration,
and an integration test on a real temporary Git repository. That test proves reads come from the
ref, ignore an inherited `GIT_DIR`, and leave the repository (including `.git`) byte-for-byte
unchanged.
