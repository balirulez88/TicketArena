// Public entry point of the messaging package.

export type { CausedEventInput, EmitCausedEvent, JsonValue } from "./caused-event.js";
export {
  type ConsumerRunner,
  type ConsumerRunnerOptions,
  createConsumerRunner,
  type HandlerContext,
} from "./consumer-runner.js";
export {
  connectJetStreamMessageBus,
  DEFAULT_ACK_WAIT_MS,
  type JetStreamMessageBusOptions,
} from "./jetstream-message-bus.js";
export type {
  ConsumerSpec,
  FetchOptions,
  MessageBus,
  MessageSubscription,
  PublishAck,
  PublishInput,
  ReceivedMessage,
  StreamKind,
} from "./message-bus.js";
export {
  createOutboxRelay,
  DEFAULT_RELAY_BATCH_SIZE,
  DEFAULT_RELAY_INTERVAL_MS,
  type OutboxRelay,
  type OutboxRelayOptions,
} from "./outbox-relay.js";
export type { ServiceName } from "./service-store.js";
