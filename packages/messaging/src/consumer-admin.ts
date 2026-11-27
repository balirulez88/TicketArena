// The broker operations consumer recovery needs (ADR 0011), kept apart from `MessageBus`: only the
// operator's recreation script uses them, never the relay or a consumer. Subjects are logical, as
// on the bus; the adapter applies any namespace.

/** A durable consumer of the main stream as the broker reports it. */
export interface DurableConsumerState {
  readonly filterSubject: string;
  /**
   * Every message matching the filter at or below this stream sequence is settled: acked, or
   * terminated (a dead-lettered message is terminated, so it counts too).
   */
  readonly ackFloorStreamSeq: number;
}

/** The main stream's retained range. */
export interface RetainedStreamState {
  readonly firstSeq: number;
  readonly lastSeq: number;
  /** When the first retained message was stored; null while the stream holds none. */
  readonly firstTimestamp: Date | null;
}

/** One retained message, reduced to what the checkpoint scan compares. */
export interface StoredMessageRef {
  readonly streamSeq: number;
  /** `Nats-Msg-Id`; undefined when the publisher set none. */
  readonly msgId: string | undefined;
}

/** Where a recreated consumer starts: a stream sequence, or the earliest retained message. */
export type ConsumerStart = { readonly seq: number } | "earliest";

export interface ConsumerAdmin {
  /** The durable consumer's state, or undefined when it does not exist. */
  consumerState(consumer: string): Promise<DurableConsumerState | undefined>;
  deleteConsumer(consumer: string): Promise<void>;
  /** Creates the durable with the settings every consumer runs with, delivering from `start`. */
  createConsumer(spec: {
    readonly consumer: string;
    readonly filterSubject: string;
    readonly start: ConsumerStart;
  }): Promise<void>;
  streamState(): Promise<RetainedStreamState>;
  /**
   * The retained messages matching `filterSubject` with `fromSeq <= seq <= toSeq`, in order.
   * Ending means every one of them was yielded: a scan that cannot reach the end of the range
   * throws, naming the last sequence it reached, instead of ending early.
   */
  scan(filterSubject: string, fromSeq: number, toSeq: number): AsyncIterable<StoredMessageRef>;
  close(): Promise<void>;
}
