import type { PrismaClient } from "@ticketarena/db";
import { type ServiceName, serviceStore } from "./service-store.js";

export interface OutboxLagOptions {
  readonly prisma: PrismaClient;
  /** Whose outbox to measure (ADR 0009). Defaults to booking. */
  readonly service?: ServiceName;
  /** The caller's clock reading; the age is measured against it. */
  readonly now: Date;
}

/**
 * Outbox lag for the dashboard: how long the oldest `PENDING` row has waited, in ms; 0 when none
 * waits. It grows while the relay cannot publish (broker down, stream full), so it is the signal
 * that events are held back in the outbox rather than lost.
 */
export async function measureOutboxLag(options: OutboxLagOptions): Promise<number> {
  const oldest = await serviceStore(options.service ?? "booking").oldestPendingCreatedAt(
    options.prisma,
  );
  // Rows are stamped by the database clock; a caller clock slightly behind it reads 0, not a
  // negative age.
  return oldest === null ? 0 : Math.max(0, options.now.getTime() - oldest.getTime());
}
