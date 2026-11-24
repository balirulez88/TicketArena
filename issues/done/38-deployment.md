# 38: Deployment

**What to build:** a reviewer can use the live demo: the web app on Vercel, the worker and NATS on Fly.io, and Neon and Upstash in production, with CI applying migrations before each web deploy. Spec: Deployment and CI; ADR 0013.

**Blocked by:** 34, 14, 29 (Upstash `QueueStore` adapter), 65

**Status:** done

**Completed:** 2026-11-24 on devflow/run-202611241838 (run 202611241838)

- [ ] The web app uses `adapter-neon` with the pooled URL; migrations use the direct URL via `prisma migrate deploy` in CI.
- [ ] The worker and NATS (JetStream on a volume, `sync_interval: always`) are deployed on Fly.io over private networking.
- [ ] Production configuration is validated at each app boundary; secrets are documented in `.env.example`.
- [ ] Deployment and operations are documented in `docs`, including a link to the recovery runbook.
  **Amended 2026-11-24 (PR #17 review, approved by the maintainer):** the runbook link is deferred to ticket 27, which builds the runbook and must link it from `docs/operations/deployment.md`; until then the docs link ADR 0011, the spec section and ticket 27 and say plainly that the runbook is not built yet.
