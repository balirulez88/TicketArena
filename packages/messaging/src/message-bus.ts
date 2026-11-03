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
  /** Resolves only after the broker's PubAck, so a returned ack means the message is stored. */
  publish(input: PublishInput): Promise<PublishAck>;
  subscribe(spec: ConsumerSpec): Promise<MessageSubscription>;
  close(): Promise<void>;
}
