# Operations

[← System map](../index.md)

How TicketArena runs outside a developer machine. Local and CI infrastructure (Docker Compose) is
described in [workflow](../workflow/index.md#ci); this area covers production
([ADR 0013](../adr/0013-deployment-topology.md)).

- [Deployment and operations](deployment.md): the production topology, configuration and where
  each secret lives, the deploy workflow, the [one-time setup runbook](deployment.md#one-time-setup-runbook)
  and [operating the demo](deployment.md#operating-the-demo) (health, logs, rollback, rotation,
  scaling, recovery).
