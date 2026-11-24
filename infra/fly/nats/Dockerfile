# syntax=docker/dockerfile:1
# NATS with JetStream for Fly.io (ADR 0013). Same server version as docker-compose.yml.
FROM nats:2.15.2-alpine
COPY nats.conf /etc/nats/nats.conf
CMD ["nats-server", "--config", "/etc/nats/nats.conf"]
