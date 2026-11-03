import { causedBy, type Envelope, parseEnvelope } from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** What a handler decides; the runner adds `correlationId` and `causationId`. */
export interface CausedEventInput {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly holdId?: string;
  readonly orderId?: string;
  readonly payload: JsonValue;
}

export type EmitCausedEvent = (event: CausedEventInput) => Promise<Envelope<JsonValue>>;

/**
 * Binds event writing to the message being handled. The ids are derived here, not chosen by the
 * handler, so no consumer can break the trace by forgetting or mistyping them. The outbox row
 * joins the handler's transaction: the event exists iff the handler's state change committed.
 */
export function createEmitCausedEvent(tx: TransactionClient, body: unknown): EmitCausedEvent {
  return async (event) => {
    const cause = parseEnvelope(body);
    if (cause === undefined) {
      throw new Error("cannot emit a caused event: the handled message is not a valid envelope");
    }
    const { aggregateType, aggregateId, ...fields } = event;
    const envelope: Envelope<JsonValue> = { ...fields, ...causedBy(cause) };
    await tx.outboxEvent.create({
      data: {
        id: envelope.id,
        aggregateType,
        aggregateId,
        eventType: envelope.type,
        payload: envelope,
      },
    });
    return envelope;
  };
}
