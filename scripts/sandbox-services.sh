#!/usr/bin/env bash
#
# Starts Postgres 17, Redis 7 and NATS JetStream inside the sandbox container (no Docker there)
# and exports the TEST_* variables the integration tests require. Sourced by the entrypoint so
# the exports reach ralph-loop.sh. Everything binds to 127.0.0.1 and lives in the container.

readonly SANDBOX_PG_BIN=/usr/lib/postgresql/17/bin
readonly SANDBOX_STATE="${HOME}/.services"

sandbox_wait_for() {
  local name="$1"
  shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "sandbox: ${name} did not become ready" >&2
  return 1
}

sandbox_start_services() {
  mkdir -p "${SANDBOX_STATE}"

  # Postgres: a throwaway cluster owned by the unprivileged user. fsync is off because the
  # data is disposable; correctness tests depend on locking semantics, not durability.
  "${SANDBOX_PG_BIN}/initdb" --pgdata="${SANDBOX_STATE}/pg" --username=ticketarena \
    --auth=trust --encoding=UTF8 >/dev/null
  "${SANDBOX_PG_BIN}/pg_ctl" --pgdata="${SANDBOX_STATE}/pg" --log="${SANDBOX_STATE}/pg.log" \
    --options="-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c fsync=off" \
    start >/dev/null
  sandbox_wait_for postgres "${SANDBOX_PG_BIN}/pg_isready" --host=127.0.0.1 --username=ticketarena

  redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --daemonize yes \
    --logfile "${SANDBOX_STATE}/redis.log"
  sandbox_wait_for redis redis-cli -h 127.0.0.1 ping

  # Same config file as Docker Compose; each passes its own JetStream store directory.
  nats-server --config /etc/nats/nats.conf --store_dir "${SANDBOX_STATE}/nats" \
    >"${SANDBOX_STATE}/nats.log" 2>&1 &
  sandbox_wait_for nats curl --fail --silent "http://127.0.0.1:8222/healthz?js-enabled-only=true"

  export TEST_DATABASE_URL="postgresql://ticketarena@127.0.0.1:5432/postgres"
  export TEST_REDIS_URL="redis://127.0.0.1:6379"
  export TEST_NATS_URL="nats://127.0.0.1:4222"
  echo "sandbox: postgres, redis and nats are ready"
}
