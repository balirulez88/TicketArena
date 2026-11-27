// The broker's side of message health for the admin dashboard (spec: Admin dashboard): what the
// outbox lag cannot show, because it happens after a message is stored. Read-only; nothing here
// changes a consumer or a stream.

/** One durable consumer of the main stream, as the broker counts it right now. */
export interface ConsumerDeliveryHealth {
  /** Messages matching the consumer's filter that it has not been delivered yet. */
  readonly lag: number;
  /** Messages delivered and not yet acked, nacked to a later time or terminated. */
  readonly pendingAcks: number;
  /** Of those pending acks, the ones delivered more than once: a current figure, not a total. */
  readonly redeliveries: number;
}

export interface DeliveryHealth {
  /** By durable name; `null` for a consumer the broker does not know (not created yet). */
  readonly consumers: Readonly<Record<string, ConsumerDeliveryHealth | null>>;
  readonly dlq: {
    /** Dead letters retained in the DLQ stream, across every `ta.dlq.<consumer>`. */
    readonly size: number;
    /** How long the oldest retained dead letter has waited, in ms; `null` while there is none. */
    readonly oldestAgeMs: number | null;
  };
}

export interface DeliveryHealthProbe {
  /** `now` is the caller's clock; the DLQ age is measured against it. */
  deliveryHealth(consumers: readonly string[], now: Date): Promise<DeliveryHealth>;
}
