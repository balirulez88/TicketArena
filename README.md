# TicketArena

A high-traffic ticket booking platform with a fair **digital waiting room**, built as a portfolio
project in distributed-systems design and agentic, test-driven development.

> **Status:** baseline infrastructure. Domain features are being designed through the
> `/grill-me` → `/to-spec` → `/to-tickets` workflow and land as green vertical slices.

## Problems it tackles

- **Traffic spikes at on-sale:** demand is absorbed by a Redis-backed waiting room so checkout
  and Postgres see only admitted buyers.
- **Fairness:** buyers are admitted in a defensible order, not by retry speed.
- **No overselling:** a seat is sold at most once under concurrent attempts.
- **Reliable async integration:** payments and notifications are driven by a transactional
  outbox, so no event is lost or sent for a rolled-back booking.

Architecture map: [`docs/index.md`](docs/index.md). Decisions: [`docs/adr/`](docs/adr/index.md).

## Tech stack

| Concern         | Choice                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| Monorepo        | Turborepo + pnpm workspaces                                                   |
| Language        | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Web             | Next.js App Router, Tailwind CSS v4, shadcn/ui, Zustand                       |
| API             | tRPC v11 + TanStack Query, superjson                                          |
| Database        | Neon PostgreSQL, Prisma 7 (Neon driver adapter)                               |
| Waiting room    | Upstash Redis                                                                 |
| Async messaging | Transactional outbox → Kafka or NATS (decision pending)                       |
| Quality gate    | Biome (warnings fail the build), tsc, Vitest                                  |

## Getting started

Requires Node 24 and pnpm 12 (`corepack enable pnpm`).

```bash
pnpm install
cp .env.example .env          # fill in Neon + Upstash credentials
pnpm db:generate              # generate the Prisma client
pnpm dev                      # http://localhost:3000
pnpm check                    # lint + typecheck + test
```

## How it is built: agentic TDD

The workflow combines [Matt Pocock's skills](https://github.com/mattpocock/skills) with an
automated harness:

1. **`/grill-me`**: a design-tree interview that settles every decision before any code exists.
2. **`/to-spec`**: synthesise those decisions into a PRD in `docs/specs/`.
3. **`/to-tickets`**: split the spec into tracer-bullet vertical slices in `issues/`.
4. **`ralph-loop.sh`**: for each unblocked ticket, inside a Docker sandbox, an agent goes
   **Red** (a failing test is required) → **Green** (Biome + tsc + Vitest must pass) →
   **Refactor** → **Docs**. Only green slices are committed, one atomic commit per branch.

```bash
export ANTHROPIC_API_KEY=...
pnpm sandbox --once           # build the image and run one ticket in the sandbox
./ralph-loop.sh --dry-run     # show which ticket would run next
```

Details: [`docs/workflow/`](docs/workflow/index.md) · skills: [`skills/`](skills/README.md).

## Repository layout

```text
apps/web/        Next.js app and tRPC API
packages/db/     Prisma schema, migrations and client factory
docs/            hierarchical architecture docs (system map → areas → ADRs)
issues/          local ticket tracker consumed by the harness
skills/          agent workflow skills
ralph-loop.sh    Red-Green-Refactor harness
Dockerfile       agent sandbox
```

## License

MIT. Vendored skills in `skills/` are © Matt Pocock, MIT ([`skills/UPSTREAM-LICENSE`](skills/UPSTREAM-LICENSE)).
