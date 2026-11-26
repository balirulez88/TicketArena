# Deployment and operations

[← Operations](index.md) · [← System map](../index.md)

The live demo follows [ADR 0013](../adr/0013-deployment-topology.md): the web app on Vercel, the
worker and NATS on Fly.io, Postgres on Neon and Redis on Upstash. Everything needed to deploy is in
the repository; the accounts, apps and secrets are created once by a human
([one-time setup](#one-time-setup-runbook)).

## Topology

| Component      | Runs on                          | Defined by                                                                | Deployed by                                   |
| -------------- | -------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| `apps/web`     | Vercel (project root `apps/web`) | `apps/web/vercel.json`                                                    | `.github/workflows/deploy.yml`, job `web`     |
| `apps/worker`  | Fly.io app `ticketarena-worker`  | `infra/fly/worker/` (`fly.toml`, `Dockerfile`, `Dockerfile.dockerignore`) | `.github/workflows/deploy.yml`, job `worker`  |
| NATS JetStream | Fly.io app `ticketarena-nats`    | `infra/fly/nats/` (`fly.toml`, `nats.conf`, `Dockerfile`)                 | by hand (`fly deploy`, rarely changes)        |
| Postgres       | Neon                             | `packages/db/prisma/migrations`                                           | `.github/workflows/deploy.yml`, job `migrate` |
| Redis          | Upstash                          | none (keys are created by the apps)                                       | n/a                                           |

Connections:

- **Web → Neon** over the **pooled** endpoint (`ep-…-pooler.<region>.aws.neon.tech`) with the
  Neon serverless driver (`@prisma/adapter-neon`, `DATABASE_DRIVER` default `neon`). Each Vercel
  function instance opens its own connections, so it must go through Neon's PgBouncer.
- **Migrations → Neon** over the **direct** endpoint (no `-pooler`): `prisma migrate deploy`
  takes a session-level advisory lock, which a transaction-mode pooler cannot hold.
- **Worker → Neon** over the direct endpoint with `pg` (one small, long-lived TCP pool).
- **Worker → NATS** over Fly's private IPv6 network (6PN) as `nats://ticketarena-nats.internal:4222`.
  Neither Fly app has a `[http_service]` or `[[services]]` table, so neither has a public address;
  NATS listens on `[::]` and is reachable only from apps in the same Fly organization. Every
  app in that organization shares the network, so NATS also requires a client token
  (`authorization { token: $NATS_TOKEN }` in `infra/fly/nats/nats.conf`, from a Fly secret);
  the worker sends the same `NATS_TOKEN`, and `parseWorkerEnv` refuses a `*.internal`
  `NATS_URL` without one. The monitoring port (health check) needs no token.
- **Web and worker → Upstash.** The web app's booking counters and the admin rate limiter use
  the Upstash REST API (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). The waiting-room
  queue (web and worker) and the worker's saga counters use node-redis over Upstash's TLS Redis
  endpoint (`REDIS_URL=rediss://default:<token>@<host>:6379`), the same database and keys. This
  split amends ADR 0013's "REST adapter in web and worker", as accepted in
  [ADR 0025](../adr/0025-node-redis-over-tls-for-the-queue.md).

NATS: JetStream stores on the Fly volume `nats_data` mounted at `/data` (`store_dir:
/data/jetstream`), with `sync_interval: always` (fsync every write, as locally) and
`max_file_store: 768MB` below the 1 GB volume. Local and CI keep using `infra/nats/nats.conf`;
the durability settings must stay the same in both files.

Single points of failure (accepted in ADR 0013): one NATS node and one worker machine. A NATS or
worker outage delays payments, notifications, expiry and admissions; it never decides a seat,
and the outbox keeps every event until the relay publishes it.

## Configuration and secrets

Every app validates its configuration with zod at its boundary and fails fast naming the
offending variable; packages never read `process.env`.

| Boundary                      | Validator                                                      | Production-specific rules                                                                             |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Web (Vercel functions)        | `parseServerEnv` and its slices (`apps/web/src/server/env.ts`) | `DATABASE_URL` on a `*.neon.tech` host must be the `-pooler` endpoint; Upstash REST URL must be https |
| Worker (Fly machine start-up) | `parseWorkerEnv` (`apps/worker/src/env.ts`)                    | `NATS_URL` `nats://`/`tls://`; `REDIS_URL` `redis://`/`rediss://`                                     |
| Migrations (deploy workflow)  | shell guard in the `migrate` job                               | `DATABASE_URL_UNPOOLED` must be a Postgres URL and not a `-pooler` host                               |

Where each secret lives (also listed, without values, at the end of `.env.example`):

| Variable                                                  | Vercel (web) | Fly `ticketarena-worker`                       | GitHub secret | Notes                                                            |
| --------------------------------------------------------- | ------------ | ---------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                            | pooled       | direct (`fly secrets`)                         |               | Neon                                                             |
| `DATABASE_URL_UNPOOLED`                                   |              |                                                | direct        | migrations only                                                  |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`      | yes          |                                                |               | metrics, admin rate limiter                                      |
| `REDIS_URL`                                               | `rediss://…` | `rediss://…` (`fly secrets`)                   |               | waiting-room queue                                               |
| `SESSION_SECRET`, `ADMISSION_SECRET`                      | yes          |                                                |               | ≥ 32 bytes each, `openssl rand -hex 32`, distinct                |
| `ADMIN_PASSWORD`                                          | yes          |                                                |               | ≥ 12 characters                                                  |
| `NATS_TOKEN`                                              |              | yes (`fly secrets`), and on `ticketarena-nats` |               | ≥ 32 characters, `openssl rand -hex 32`, same value on both apps |
| `NATS_URL`, `PORT`, `ADMIT_RATE_PER_SECOND`, `MAX_ACTIVE` |              | `[env]` in `fly.toml` (not secret)             |               |                                                                  |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`      |              |                                                | yes           | Vercel CLI                                                       |
| `FLY_API_TOKEN`                                           |              |                                                | yes           | `fly tokens create deploy -a ticketarena-worker`                 |

## Deploy workflow

`.github/workflows/deploy.yml` (separate from `ci.yml`, which stays the quality gate) starts when
`CI` completes successfully for a **push** to `main` of this repository, or by hand
(`workflow_dispatch`) on `main`. It runs:

1. `gate`: first resolves the one commit this run may deploy
   (`apps/worker/src/deploy/deploy-target.ts`, run with plain `node`): the current tip of `main`,
   and only if the latest CI run of a push of that exact commit passed. A re-run of an old CI run
   is skipped with a notice, since migrations never roll back and older code would land on a newer
   schema; a manual run fails if its commit's CI is pending, failed, missing, or if `main` moved
   meanwhile. Every later job checks out that pinned commit (`needs.gate.outputs.sha`) and, right
   before it changes production, re-checks it with the same script (`EVENT_NAME: recheck`): a
   partial re-run ("Re-run failed jobs") keeps the old gate's outputs, so a job re-run after a
   newer deployment fails instead of shipping the older commit. Then the gate
   checks which targets have their secrets. A target whose secrets are absent is skipped with a
   notice, so the workflow is green (not red) before the setup below or on a fork.
2. `migrate`: `prisma migrate deploy` with `DATABASE_URL_UNPOOLED`.
3. `web` and `worker`, both `needs: [gate, migrate]`, so neither runs unless the migrations
   succeeded: `vercel pull` / `vercel build --prod` / `vercel deploy --prebuilt --prod`, and
   `flyctl deploy --ha=false` with the worker's files.

Vercel's own git deployments are disabled (`git.deploymentEnabled: false` in `vercel.json`), so a
push cannot deploy the web app before its migrations. `vercel.json` also sets the build command
to `pnpm --filter @ticketarena/db db:generate && pnpm run build`, because the Prisma client is
generated, not committed. One deployment runs at a time (`concurrency: deploy-production`).

Migrations must stay backward compatible with the running code for the minutes between `migrate`
and the new web and worker versions going live (expand first, contract in a later deploy).

`apps/worker/src/deploy-config.test.ts` and `apps/web/src/deploy-config.test.ts` pin these
properties (volume and `store_dir`, `sync_interval`, no public services, the worker's NATS URL and
health check, the job order, `vercel.json`), and run the worker's `[env]` plus sample secrets
through `parseWorkerEnv`.

## One-time setup runbook

Done once by a maintainer with accounts on each platform. Names below are the defaults in the
repository; Fly app names are global, so if one is taken, change `app` in the `fly.toml` (and,
for NATS, the host in the worker's `NATS_URL`) and the commands below.

1. **Neon.** Create a project (region `aws-eu-central-1`, next to Fly `fra`) and a database
   `ticketarena`. Copy both connection strings: the **pooled** one (host contains `-pooler`) and
   the **direct** one.
2. **Upstash.** Create a Redis database (region `eu-central-1`, TLS on). Copy the REST URL and
   token, and the TLS Redis URL (`rediss://default:<token>@<host>:6379`).
3. **Database schema and catalog.** From a checkout, with the direct URL:
   `DATABASE_URL=<direct> pnpm --filter @ticketarena/db exec prisma migrate deploy`, then
   `DATABASE_URL=<direct> pnpm --filter @ticketarena/worker db:seed` (the demo catalog; seeding is
   not part of the deploy workflow).
4. **NATS on Fly.** `fly apps create ticketarena-nats`, then
   `fly volumes create nats_data --app ticketarena-nats --region fra --size 1`, then
   `fly secrets set --app ticketarena-nats --stage NATS_TOKEN=<openssl rand -hex 32>` (NATS refuses
   to start without it), then from the
   repository root `fly deploy infra/fly/nats --ha=false` (the directory argument is the working
   directory, so its `fly.toml` is found there; a `--config` path would resolve inside it).
   Check: `fly checks list --app ticketarena-nats` shows `jetstream` passing.
5. **Worker on Fly.** `fly apps create ticketarena-worker`, then
   `fly secrets set --app ticketarena-worker --stage DATABASE_URL=<direct> REDIS_URL=<rediss url> NATS_TOKEN=<the same token>`,
   then from the repository root
   `fly deploy . --config infra/fly/worker/fly.toml --dockerfile infra/fly/worker/Dockerfile --ignorefile infra/fly/worker/Dockerfile.dockerignore --ha=false`.
   `--ignorefile` matters: the root `.dockerignore` belongs to the frozen harness sandbox and
   excludes the source. Check: `fly checks list --app ticketarena-worker` shows `health` passing
   and `fly logs --app ticketarena-worker` shows `worker listening`. Make sure exactly one machine
   runs (`fly scale count 1 --app ticketarena-worker`).
6. **Vercel.** Import the GitHub repository as a project with **Root Directory `apps/web`**
   (framework Next.js; `vercel.json` supplies the build command and turns git deployments off).
   In Settings → Environment Variables (Production) add `DATABASE_URL` (pooled),
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDIS_URL`, `SESSION_SECRET`,
   `ADMISSION_SECRET` and `ADMIN_PASSWORD`; leave `DATABASE_DRIVER` unset. Note the project and
   team ids (`vercel link` writes them to `.vercel/project.json`; do not commit that directory)
   and create a token (Account Settings → Tokens).
7. **GitHub.** Repository Settings → Secrets and variables → Actions: add
   `DATABASE_URL_UNPOOLED` (direct), `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and
   `FLY_API_TOKEN` (`fly tokens create deploy --app ticketarena-worker`).
8. **First deploy.** Actions → Deploy → Run workflow on `main`. All three jobs (`migrate`, `web`,
   `worker`) must run, none skipped. Open the Vercel production URL: `/events` lists the seeded
   events and `/admin/login` accepts `ADMIN_PASSWORD`.

From then on every push to `main` that passes CI deploys itself.

## Operating the demo

- **Health.** `fly checks list --app ticketarena-worker` (`/health`, reports Redis too) and
  `--app ticketarena-nats` (`/healthz?js-enabled-only=true`). The `/admin` dashboard shows queue,
  seats, orders and pending payments live.
- **Stopping.** Fly sends SIGTERM and kills after `kill_timeout = "30s"`. The worker stops its
  loops and connections within `DEFAULT_SHUTDOWN_DEADLINE_MS` (25 s, `apps/worker/src/lifecycle.ts`),
  then exits 0; a failed stop or the deadline exits 1 and logs the component (`worker did not stop
  within ...`). A start that fails (for example the health port is taken) logs `worker failed to
  start` and exits 1.
- **Logs.** `fly logs --app ticketarena-worker` (pino JSON, `correlationId` per flow); Vercel →
  Project → Logs for the web app.
- **Rollback.** The default is a revert commit pushed to `main`: it passes CI and deploys like any
  change, with the migrations left in place. Migrations are forward-only: fix forward with a new
  migration. An emergency rollback of the code alone, outside the workflow, is allowed only to the
  release that ran immediately before the last deploy, which the expand/contract rule above keeps
  compatible with the current schema: web `vercel rollback` (or promote that deployment in the
  dashboard); worker `fly releases --app ticketarena-worker --image`, then
  `fly deploy --image <that image>` with the same flags. Follow it with the revert on `main`, or
  the next deploy brings the change back.
- **Secret rotation.** `SESSION_SECRET` logs out every session and admin; `ADMISSION_SECRET`
  revokes every admission token; both take effect on the next Vercel deployment. A Neon or
  Upstash credential change must be applied to Vercel, Fly (`fly secrets set`, which restarts the
  worker) and GitHub together. A new `NATS_TOKEN` goes to both Fly apps: set it on
  `ticketarena-worker` with `--stage`, then on `ticketarena-nats` (restarts NATS), then
  `fly secrets deploy --app ticketarena-worker`; the worker is refused while the two differ.
- **Scaling.** Exactly one worker machine and one NATS machine. Never `fly scale count` above 1:
  the admission ticker and reaper assume a single worker, and JetStream runs as a single node.
- **NATS data.** Fly snapshots the volume daily (`fly volumes snapshots list`). Losing the
  volume loses only undelivered messages and consumer positions; the outbox rows stay in Postgres.
- **Recovery.** Consumer recovery (recreating a consumer and republishing from the outbox) is
  decided in [ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md); its runbook and script are
  specified in the [MVP spec](../specs/ticketarena-mvp.md#consumer-recovery-runbook-and-script)
  and built by ticket 27 (`issues/27-consumer-recovery-and-outbox-republish.md`). Until then
  there is no recovery runbook beyond the steps above.
