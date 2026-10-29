# syntax=docker/dockerfile:1
#
# Disposable sandbox for the Ralph loop. The agent runs with permission prompts disabled, so it
# gets nothing but a toolchain, the test services, an unprivileged user and a clone of the repo
# (see scripts/sandbox-entrypoint.sh). There is no Docker inside, so Postgres, Redis and NATS
# run as plain processes (scripts/sandbox-services.sh), matching docker-compose.yml versions.

FROM node:24-bookworm-slim

ARG PNPM_VERSION=12.15.0
ARG CLAUDE_CODE_VERSION=2.1.312
ARG NATS_VERSION=2.15.2
ARG TARGETARCH

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates openssl curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Postgres 17 from the PGDG repository (Debian bookworm ships 15). The package must not create
# its own root-owned cluster: the entrypoint creates one for the unprivileged user.
RUN install -d /usr/share/postgresql-common/pgdg /etc/postgresql-common \
  && curl --fail --silent --show-error --location \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.conf \
  && apt-get update \
  && apt-get install --yes --no-install-recommends postgresql-17 redis-server \
  && rm -rf /var/lib/apt/lists/*

# nats-server release binary, verified against the published SHA256SUMS.
RUN set -eux; \
  archive="nats-server-v${NATS_VERSION}-linux-${TARGETARCH}"; \
  base="https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}"; \
  cd /tmp; \
  curl --fail --silent --show-error --location --remote-name "${base}/${archive}.tar.gz"; \
  curl --fail --silent --show-error --location --remote-name "${base}/SHA256SUMS"; \
  grep " ${archive}.tar.gz\$" SHA256SUMS | sha256sum --check --strict; \
  tar --extract --gzip --file "${archive}.tar.gz"; \
  install --mode=0755 "${archive}/nats-server" /usr/local/bin/nats-server; \
  rm -rf /tmp/*; \
  nats-server --version

RUN npm install --global "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

COPY infra/nats/nats.conf /etc/nats/nats.conf
COPY --chmod=0755 scripts/sandbox-services.sh /usr/local/lib/sandbox-services.sh
COPY --chmod=0755 scripts/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint

ENV RALPH_SANDBOX=1 \
  CI=1 \
  NEXT_TELEMETRY_DISABLED=1 \
  TURBO_TELEMETRY_DISABLED=1 \
  DISABLE_AUTOUPDATER=1

USER node
WORKDIR /home/node

ENTRYPOINT ["sandbox-entrypoint"]
