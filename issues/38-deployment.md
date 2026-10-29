# 38: Deployment

**What to build:** a reviewer can use the live demo: the web app on Vercel, the worker and NATS on Fly.io, and Neon and Upstash in production, with CI applying migrations before each web deploy. Spec: Deployment and CI; ADR 0013.

**Blocked by:** 34, 36, 29

**Status:** ready-for-agent

- [ ] The web app uses `adapter-neon` with the pooled URL; migrations use the direct URL via `prisma migrate deploy` in CI.
- [ ] The worker and NATS (JetStream on a volume, `sync_interval: always`) are deployed on Fly.io over private networking.
- [ ] Production configuration is validated at each app boundary; secrets are documented in `.env.example`.
- [ ] Deployment and operations are documented in `docs`, including a link to the recovery runbook.
