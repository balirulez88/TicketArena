import {
  type Consumer,
  DiscardPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
} from "@nats-io/jetstream";
import {
  connect,
  InvalidArgumentError,
  type NatsConnection,
  RequestError,
} from "@nats-io/transport-node";
import {
  type ConsumerSpec,
  type FetchOptions,
  type MessageBus,
  type MessageSubscription,
  PermanentPublishError,
  type PublishAck,
  type PublishInput,
  type ReceivedMessage,
  type StreamKind,
} from "./message-bus.js";

const NANOS_PER_MS = 1_000_000;
const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;
const MSG_ID_HEADER = "Nats-Msg-Id";
// JetStream API error code for "stream name already in use with a different configuration".
const STREAM_NAME_EXISTS = 10058;
// Publish-failure classification (ADR 0022), pinned by publish-failure-classification.test.ts
// against real NATS (@nats-io 3.4.0):
// - an oversized payload is refused by the client itself, before anything is sent, with an
//   `InvalidArgumentError` whose message names `max_payload` (the server's limit from INFO);
// - a subject no stream captures gets no PubAck responder: the client reports `JetStreamNotEnabled`
//   with a no-responders `RequestError` as its cause. A JetStream that is down or still recovering
//   answers the same way, so that alone is never permanent: only the JetStream API's own
//   "no stream matches subject" (`JetStreamApiCodes.StreamNotFound`, 10059) to a stream lookup
//   for the subject confirms it.
// Everything else (timeouts, connection loss, a full stream) is transient.
const MAX_PAYLOAD_EXCEEDED = "max_payload";

export const DEFAULT_ACK_WAIT_MS = 30_000;

export interface JetStreamMessageBusOptions {
  readonly servers: string;
  /** Client token for a server that requires one (production NATS on Fly.io). */
  readonly token?: string;
  /** Prepended to stream names; lets parallel test files own disjoint streams. */
  readonly streamPrefix?: string;
  /** Root token prepended to every subject, for the same isolation. */
  readonly subjectPrefix?: string;
  /**
   * Overrides a stream's `max_bytes`; production keeps the ADR 0004 sizes. Lets a test fill a
   * stream to exercise `discard: new` backpressure.
   */
  readonly streamMaxBytes?: Partial<Record<StreamKind, number>>;
  /** Bound on a PubAck or JetStream API answer; the NATS client's 5 s default when omitted. */
  readonly requestTimeoutMs?: number;
  /** Wait between reconnect attempts; the NATS client's 2 s default when omitted. */
  readonly reconnectTimeWaitMs?: number;
}

interface StreamDefinition {
  readonly name: string;
  readonly subjects: readonly string[];
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  readonly duplicateWindowMs: number;
}

const STREAMS: Readonly<Record<StreamKind, StreamDefinition>> = {
  main: {
    name: "TICKETARENA",
    subjects: ["ta.seat.>", "ta.hold.>", "ta.order.>", "ta.payment.>"],
    maxAgeMs: 7 * DAY_MS,
    maxBytes: 1024 * MIB,
    // NATS default; the ticket pins the window only for the DLQ.
    duplicateWindowMs: 2 * 60_000,
  },
  dlq: {
    name: "TICKETARENA_DLQ",
    subjects: ["ta.dlq.>"],
    maxAgeMs: 30 * DAY_MS,
    maxBytes: 256 * MIB,
    duplicateWindowMs: 10 * 60_000,
  },
};

/** The only module allowed to import `@nats-io/*`. */
export async function connectJetStreamMessageBus(
  options: JetStreamMessageBusOptions,
): Promise<MessageBus> {
  const timeout =
    options.requestTimeoutMs === undefined ? {} : { timeout: options.requestTimeoutMs };
  const connection = await connect({
    servers: options.servers,
    ...(options.token === undefined ? {} : { token: options.token }),
    // Reconnect for as long as the broker is away: the client's default gives up after 10
    // attempts and closes the connection for good, so an outage of ~20 s would stop the relay
    // until a restart. A broker outage, however long, must end with every row published.
    maxReconnectAttempts: -1,
    ...(options.reconnectTimeWaitMs === undefined
      ? {}
      : { reconnectTimeWait: options.reconnectTimeWaitMs }),
  });
  try {
    const manager = await jetstreamManager(connection, timeout);
    return new JetStreamMessageBus(
      connection,
      manager,
      jetstream(connection, timeout),
      options.streamPrefix ?? "",
      options.subjectPrefix === undefined ? "" : `${options.subjectPrefix}.`,
      options.streamMaxBytes ?? {},
    );
  } catch (error) {
    await connection.close();
    throw error;
  }
}

class JetStreamMessageBus implements MessageBus {
  constructor(
    private readonly connection: NatsConnection,
    private readonly manager: JetStreamManager,
    private readonly client: JetStreamClient,
    private readonly streamPrefix: string,
    private readonly subjectPrefix: string,
    private readonly streamMaxBytes: Partial<Record<StreamKind, number>>,
  ) {}

  async ensureTopology(): Promise<void> {
    for (const kind of ["main", "dlq"] as const) {
      const definition = STREAMS[kind];
      const config: Partial<StreamConfig> & { name: string } = {
        name: this.streamName(kind),
        subjects: definition.subjects.map((subject) => `${this.subjectPrefix}${subject}`),
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.New,
        max_age: definition.maxAgeMs * NANOS_PER_MS,
        max_bytes: this.streamMaxBytes[kind] ?? definition.maxBytes,
        duplicate_window: definition.duplicateWindowMs * NANOS_PER_MS,
      };
      // `add` is idempotent for an identical config and fails on a differing one; only then does
      // `update` converge, in place, a stream created by an older version of the topology. Any
      // other failure (invalid config, broker unreachable) is rethrown as is: an update would
      // only fail again and replace the cause with its own error (TD-036).
      try {
        await this.manager.streams.add(config);
      } catch (error) {
        if (!(error instanceof JetStreamApiError && error.code === STREAM_NAME_EXISTS)) {
          throw error;
        }
        await this.manager.streams.update(config.name, config);
      }
    }
  }

  async publish(input: PublishInput): Promise<PublishAck> {
    const subject = this.subjectPrefix + input.subject;
    try {
      const ack = await this.client.publish(subject, input.data, { msgID: input.msgId });
      return { streamSeq: ack.seq, duplicate: ack.duplicate };
    } catch (error) {
      throw await this.classifyPublishFailure(subject, error);
    }
  }

  /** The permanent failure `error` proves, or `error` itself (transient). See the constants. */
  private async classifyPublishFailure(subject: string, error: unknown): Promise<unknown> {
    if (error instanceof InvalidArgumentError && error.message.includes(MAX_PAYLOAD_EXCEEDED)) {
      return new PermanentPublishError(
        "payload_too_large",
        `payload exceeds the broker's max_payload of ${this.connection.info?.max_payload ?? "?"} bytes`,
        { cause: error },
      );
    }
    if (!(error instanceof Error && isNoResponders(error.cause))) {
      return error;
    }
    try {
      await this.manager.streams.find(subject);
    } catch (lookup) {
      if (lookup instanceof JetStreamApiError && lookup.code === JetStreamApiCodes.StreamNotFound) {
        return new PermanentPublishError("no_stream", `no stream matches subject ${subject}`, {
          cause: error,
        });
      }
    }
    // A stream does capture the subject, or the lookup failed too: JetStream is unavailable.
    return error;
  }

  async subscribe(spec: ConsumerSpec): Promise<MessageSubscription> {
    const stream = this.streamName(spec.stream);
    // No BackOff (it would override AckWait) and MaxDeliver -1: the server never gives up on a
    // message by itself; the application owns the retry budget (ADR 0011).
    await this.manager.consumers.add(stream, {
      durable_name: spec.consumer,
      ack_policy: "explicit",
      ack_wait: (spec.ackWaitMs ?? DEFAULT_ACK_WAIT_MS) * NANOS_PER_MS,
      max_deliver: -1,
      filter_subject: this.subjectPrefix + spec.filterSubject,
    });
    const consumer = await this.client.consumers.get(stream, spec.consumer);
    return new JetStreamSubscription(consumer, this.subjectPrefix);
  }

  async close(): Promise<void> {
    await this.connection.drain();
  }

  private streamName(kind: StreamKind): string {
    return this.streamPrefix + STREAMS[kind].name;
  }
}

class JetStreamSubscription implements MessageSubscription {
  constructor(
    private readonly consumer: Consumer,
    private readonly subjectPrefix: string,
  ) {}

  async fetch(options: FetchOptions): Promise<ReceivedMessage[]> {
    const batch = await this.consumer.fetch({
      max_messages: options.maxMessages,
      expires: options.expiresMs,
    });
    const received: ReceivedMessage[] = [];
    for await (const message of batch) {
      received.push(toReceived(message, this.subjectPrefix));
    }
    return received;
  }
}

function isNoResponders(error: unknown): boolean {
  return error instanceof RequestError && error.isNoResponders();
}

function toReceived(message: JsMsg, subjectPrefix: string): ReceivedMessage {
  const msgId = message.headers?.get(MSG_ID_HEADER);
  return {
    subject: message.subject.slice(subjectPrefix.length),
    data: new TextDecoder().decode(message.data),
    msgId: msgId === undefined || msgId === "" ? undefined : msgId,
    streamSeq: message.info.streamSequence,
    deliveryCount: message.info.deliveryCount,
    ack: () => message.ack(),
    nak: (delayMs) => message.nak(delayMs),
    term: (reason) => message.term(reason),
    working: () => message.working(),
  };
}
