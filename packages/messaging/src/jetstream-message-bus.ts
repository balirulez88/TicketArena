import {
  type Consumer,
  DiscardPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
} from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type {
  ConsumerSpec,
  FetchOptions,
  MessageBus,
  MessageSubscription,
  PublishAck,
  PublishInput,
  ReceivedMessage,
  StreamKind,
} from "./message-bus.js";

const NANOS_PER_MS = 1_000_000;
const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;
const MSG_ID_HEADER = "Nats-Msg-Id";

export const DEFAULT_ACK_WAIT_MS = 30_000;

export interface JetStreamMessageBusOptions {
  readonly servers: string;
  /** Prepended to stream names; lets parallel test files own disjoint streams. */
  readonly streamPrefix?: string;
  /** Root token prepended to every subject, for the same isolation. */
  readonly subjectPrefix?: string;
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
  const connection = await connect({ servers: options.servers });
  try {
    const manager = await jetstreamManager(connection);
    return new JetStreamMessageBus(
      connection,
      manager,
      jetstream(connection),
      options.streamPrefix ?? "",
      options.subjectPrefix === undefined ? "" : `${options.subjectPrefix}.`,
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
        max_bytes: definition.maxBytes,
        duplicate_window: definition.duplicateWindowMs * NANOS_PER_MS,
      };
      // `add` is idempotent for an identical config and fails on a differing one; `update`
      // then converges a stream created by an older version of the topology.
      try {
        await this.manager.streams.add(config);
      } catch {
        await this.manager.streams.update(config.name, config);
      }
    }
  }

  async publish(input: PublishInput): Promise<PublishAck> {
    const ack = await this.client.publish(this.subjectPrefix + input.subject, input.data, {
      msgID: input.msgId,
    });
    return { streamSeq: ack.seq, duplicate: ack.duplicate };
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
