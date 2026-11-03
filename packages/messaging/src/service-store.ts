import type { TransactionClient } from "@ticketarena/db";

/**
 * Each service owns its outbox and its `processed_messages` in its own schema (ADR 0009). The
 * relay and the consumer runner are shared code, so they reach those tables only through this
 * binding; nothing else in them knows which schema they run against.
 */
export type ServiceName = "booking" | "payment";

export interface OutboxRowInput {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: object;
}

export interface ProcessedMessageInput {
  readonly consumer: string;
  readonly messageId: string;
  readonly streamSeq: bigint;
}

export interface ServiceStore {
  /** Schema-qualified outbox table for the relay's raw claim query; a constant, never input. */
  readonly outboxTable: string;
  insertOutbox(tx: TransactionClient, row: OutboxRowInput): Promise<void>;
  markPublished(tx: TransactionClient, id: string): Promise<void>;
  recordPublishFailure(tx: TransactionClient, id: string, error: string): Promise<void>;
  insertProcessed(tx: TransactionClient, row: ProcessedMessageInput): Promise<void>;
}

const bookingStore: ServiceStore = {
  outboxTable: '"public"."outbox_events"',
  async insertOutbox(tx, data) {
    await tx.outboxEvent.create({ data });
  },
  async markPublished(tx, id) {
    await tx.outboxEvent.update({
      where: { id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
  },
  async recordPublishFailure(tx, id, error) {
    await tx.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    });
  },
  async insertProcessed(tx, data) {
    await tx.processedMessage.create({ data });
  },
};

const paymentStore: ServiceStore = {
  outboxTable: '"payment"."outbox_events"',
  async insertOutbox(tx, data) {
    await tx.paymentOutboxEvent.create({ data });
  },
  async markPublished(tx, id) {
    await tx.paymentOutboxEvent.update({
      where: { id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
  },
  async recordPublishFailure(tx, id, error) {
    await tx.paymentOutboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    });
  },
  async insertProcessed(tx, data) {
    await tx.paymentProcessedMessage.create({ data });
  },
};

export function serviceStore(service: ServiceName): ServiceStore {
  return service === "payment" ? paymentStore : bookingStore;
}
