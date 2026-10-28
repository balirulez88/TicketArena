# 0001: Turborepo + pnpm monorepo

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The system has a web app plus several independently deployable services (outbox relay, payment
and notification consumers) that share the database schema and event types. Shared contracts
must change atomically with their producers and consumers.

## Decision

One repository managed by **pnpm workspaces** (`apps/*`, `packages/*`) with **Turborepo** for
task orchestration and caching. Internal packages export TypeScript source directly.

## Alternatives considered

- **Polyrepo:** cross-service contract changes become multi-PR, version-skew problems.
- **Nx:** more capable but heavier than this project needs.
- **Plain pnpm scripts:** no task graph or caching; CI and the Ralph loop would rerun everything.

## Consequences

- An event payload change and its consumers land in one commit and one gate run.
- Package boundaries must be policed by convention (dependency direction in
  `docs/architecture/index.md`) because the workspace makes every package importable.
