# syntax=docker/dockerfile:1
#
# Production image of apps/worker for Fly.io (ADR 0013). Built from the repository root, because
# the worker runs its workspace packages from source:
#   docker build -f infra/fly/worker/Dockerfile .
# BuildKit then applies Dockerfile.dockerignore next to this file (the root .dockerignore belongs
# to the frozen harness sandbox); `fly deploy` gets the same file through --ignorefile.

FROM node:24-bookworm-slim

# The version in package.json `packageManager`.
ARG PNPM_VERSION=12.15.0
# Prisma detects the OpenSSL version to pick its engine files; the slim image ships none.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /app
COPY . .

# Only the worker and the workspace packages it depends on. Dev dependencies stay: the worker runs
# TypeScript through tsx, and `prisma generate` needs the Prisma CLI.
RUN pnpm install --frozen-lockfile --filter "@ticketarena/worker..." \
  && pnpm --filter @ticketarena/db db:generate

ENV NODE_ENV=production
USER node
WORKDIR /app/apps/worker
EXPOSE 8080
# tsx directly, not `pnpm start`, so SIGTERM from Fly reaches the worker's graceful shutdown.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
