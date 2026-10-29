# 0009: One database, one schema and one outbox per service

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

Booking, Payment and Notification are modelled as separate services but run in one worker app
against one Neon database, to keep operations small. The boundaries must still be real, so the
modules can be extracted later without a data migration.

## Decision

- Prisma `multiSchema`: `public` (booking), `payment`, `notification`.
- Each service writes only its own schema and has its **own** `outbox_events` and
  `processed_messages` tables. Services communicate only through events; no service reads another
  service's tables. Events therefore carry the data their consumers need (e.g. contact details).
- The dashboard's live feed is the union of all outbox tables read by cursor `(createdAt, id)`:
  every integration event starts as an outbox row, so the outbox is the event log.
- Each module lives in its own package or worker module behind one public entry point, and
  communicates only through its own subjects.

## Alternatives considered

- **One shared schema:** easy joins, but nothing stops cross-service coupling.
- **Separate databases now:** real isolation at the cost of three Neon projects and three
  connection pools for a demo.

## Consequences

- No cross-schema foreign keys; consistency between services is eventual, via events.
- Contact data travels inside events and is retained in the stream for its `max_age` (7 days).
