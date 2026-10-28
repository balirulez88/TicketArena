# 0003: Transactional outbox for async integrations

- **Status:** Accepted (broker choice open: Kafka vs NATS JetStream)
- **Date:** 2026-10-28

## Context

A confirmed booking must trigger payment capture and a notification. Writing to Postgres and
publishing to a broker in one request is a **dual write**: either can fail independently,
producing a booking with no payment event, or an event for a booking that rolled back.

## Decision

Integration events are inserted into `outbox_events` **in the same database transaction** as the
business change. A separate relay publishes pending rows to the broker and marks them published.
Consumers are idempotent, keyed on the event id.

## Alternatives considered

- **Publish after commit:** a crash between commit and publish silently loses the event.
- **Distributed transactions (2PC/XA):** unsupported by the broker candidates and serverless
  Postgres; couples availability of all participants.
- **CDC from the WAL (Debezium):** strong option, but heavier infrastructure; may supersede the
  polling relay later.

## Consequences

- Delivery is at-least-once; duplicate handling is mandatory in every consumer.
- Event latency equals relay poll interval plus publish time; it needs monitoring (outbox lag).
- The relay is a long-running process and cannot live inside serverless Next.js.
