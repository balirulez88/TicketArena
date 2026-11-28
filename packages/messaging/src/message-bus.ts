// The port every application module talks to. Nothing outside the JetStream adapter may import
// the NATS client (ADR 0004), so a different broker only needs a new adapter.

/** The two streams of the topology; the DLQ never shares subjects with the main stream. */
export type StreamKind = "main" | "dlq";

export interface PublishInput {
  /** Logical subject such as `ta.order.placed`; the adapter may namespace it. */
  readonly subject: string;
  readonly data: string;
  /** Broker-side dedupe key (`Nats-Msg-Id`): the outbox row id for relayed events. */
  readonly msgId: string;
  /** Extra message headers; values must not contain CR or LF. They count towards the limit. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Why a publish can never succeed for this message, however often it is retried (ADR 0022):
 * `no_stream` (no stream's subjects match it), `payload_too_large` (over the broker's maximum),
 * `unserialisable` (the payload cannot be turned into the message's data).
 */
export type PermanentPublishReason = "no_stream" | "payload_too_large" | "unserialisable";

/**
 * A publish failure specific to the message, not to the broker. Adapters throw it only when they
 * are sure; every other failure (connection lost, PubAck timeout, broker unavailable, stream
 * full) is transient, so an outage of any length is never mistaken for a bad message.
 */
export class PermanentPublishError extends Error {
  override readonly name = "PermanentPublishError";

  constructor(
    readonly reason: PermanentPublishReason,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface PublishAck {
  readonly streamSeq: number;
  /** True when the broker recognised `msgId` inside its duplicate window and stored nothing. */
  readonly duplicate: boolean;
}

export interface ConsumerSpec {
  readonly stream: StreamKind;
  /** Durable name: stays stable across restarts so the server keeps the consumer's position. */
  readonly consumer: string;
  /** Logical subject filter, for example `ta.order.>`. */
  readonly filterSubject: string;
  /** Crash/hang detection only (ADR 0011); production keeps the 30 s default. */
  readonly ackWaitMs?: number;
}

export interface ReceivedMessage {
  readonly subject: string;
  readonly data: string;
  /** `Nats-Msg-Id` header; undefined when the publisher did not set one. */
  readonly msgId: string | undefined;
  /** Every header the message carries, `Nats-Msg-Id` included; the JetStream adapter sets it. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly streamSeq: number;
  /** JetStream's delivery counter; it also counts crashes and AckWait expiries. */
  readonly deliveryCount: number;
  ack(): void;
  nak(delayMs?: number): void;
  term(reason?: string): void;
  working(): void;
}

export interface FetchOptions {
  readonly maxMessages: number;
  readonly expiresMs: number;
}

export interface MessageSubscription {
  /** Pulls up to `maxMessages`, resolving when they arrive or `expiresMs` elapses. */
  fetch(options: FetchOptions): Promise<ReceivedMessage[]>;
}

export interface MessageBus {
  /** Idempotently declares both streams; the worker calls it before the relay's first poll. */
  ensureTopology(): Promise<void>;
  /**
   * Resolves only after the broker's PubAck, so a returned ack means the message is stored.
   * Rejects with `PermanentPublishError` when the message itself can never be published.
   */
  publish(input: PublishInput): Promise<PublishAck>;
  /**
   * The largest message, headers and data together, the broker accepts; omitted (or undefined)
   * when the broker has no such limit or it is not known yet.
   */
  maxPayloadBytes?(): number | undefined;
  subscribe(spec: ConsumerSpec): Promise<MessageSubscription>;
  close(): Promise<void>;
}
