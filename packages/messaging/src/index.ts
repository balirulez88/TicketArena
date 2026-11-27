// Public entry point of the messaging package.

export type { CausedEventInput, EmitCausedEvent, JsonValue } from "./caused-event.js";
export type {
  ConsumerAdmin,
  ConsumerStart,
  DurableConsumerState,
  RetainedStreamState,
  StoredMessageRef,
} from "./consumer-admin.js";
export {
  type RecoveryRule,
  type RecreateConsumerOptions,
  type RecreateConsumerResult,
  recreateConsumer,
} from "./consumer-recovery.js";
export {
  type ConsumerRunner,
  type ConsumerRunnerOptions,
  createConsumerRunner,
  type DeadLetter,
  type DeadLetterCause,
  type HandlerContext,
  type HandlerOutcome,
  type MessageSchema,
} from "./consumer-runner.js";
export type {
  ConsumerDeliveryHealth,
  DeliveryHealth,
  DeliveryHealthProbe,
} from "./delivery-health.js";
export {
  connectJetStreamConsumerAdmin,
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
export {
  OutboxRepublishRefused,
  type RepublishInput,
  republishOutboxEvents,
} from "./outbox-republish.js";
export {
  DEFAULT_RETENTION_BATCH_SIZE,
  type PrunedRows,
  type PruneRetentionOptions,
  pruneRetention,
  RETENTION_MS,
} from "./outbox-retention.js";
export type { ServiceName } from "./service-store.js";
