// Public entry point of the messaging package.

export type { CausedEventInput, EmitCausedEvent, JsonValue } from "./caused-event.js";
export {
  type ConsumerRunner,
  type ConsumerRunnerOptions,
  createConsumerRunner,
  type HandlerContext,
  type HandlerOutcome,
} from "./consumer-runner.js";
export {
  connectJetStreamMessageBus,
  DEFAULT_ACK_WAIT_MS,
  type JetStreamMessageBusOptions,
} from "./jetstream-message-bus.js";
export {
  type ConsumerSpec,
  type FetchOptions,
  type MessageBus,
  type MessageSubscription,
  PermanentPublishError,
  type PermanentPublishReason,
  type PublishAck,
  type PublishInput,
  type ReceivedMessage,
  type StreamKind,
} from "./message-bus.js";
export {
  DEFAULT_MAX_PERMANENT_FAILURES,
  measureOutboxFailures,
  type OutboxFailureMetrics,
  type OutboxHistoryEntry,
  OutboxRequeueRefused,
  type RequeueInput,
  readOutboxHistory,
  requeueFailedOutboxEvent,
} from "./outbox-failures.js";
export { measureOutboxLag, type OutboxLagOptions } from "./outbox-lag.js";
export {
  createOutboxRelay,
  DEFAULT_RELAY_BATCH_SIZE,
  DEFAULT_RELAY_INTERVAL_MS,
  type OutboxRelay,
  type OutboxRelayOptions,
} from "./outbox-relay.js";
export type { ServiceName } from "./service-store.js";
