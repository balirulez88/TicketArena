# syntax=docker/dockerfile:1
#
# Disposable sandbox for the Ralph loop. The agent runs with permission prompts disabled, so it
# gets nothing but a toolchain, an unprivileged user and a clone of the repo
# (see scripts/sandbox-entrypoint.sh).

FROM node:24-bookworm-slim

ARG PNPM_VERSION=12.15.0
ARG CLAUDE_CODE_VERSION=2.1.312

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

COPY --chmod=0755 scripts/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint

ENV RALPH_SANDBOX=1 \
  CI=1 \
  NEXT_TELEMETRY_DISABLED=1 \
  TURBO_TELEMETRY_DISABLED=1 \
  DISABLE_AUTOUPDATER=1

USER node
WORKDIR /home/node

ENTRYPOINT ["sandbox-entrypoint"]
