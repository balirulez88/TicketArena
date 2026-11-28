import { createPaymentSagaHandler, type SagaMetrics } from "@ticketarena/booking";
import {
  envelopeSchema,
  type Logger,
  orderCancelledPayloadSchema,
  orderConfirmedPayloadSchema,
  orderExpiredPayloadSchema,
  orderPlacedPayloadSchema,
  paymentFailedPayloadSchema,
  paymentRefundedPayloadSchema,
  paymentRefundRequestedPayloadSchema,
  paymentSucceededPayloadSchema,
} from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import type { ConsumerRunnerOptions, MessageSchema } from "@ticketarena/messaging";
import {
  createMockNotificationProvider,
  createNotificationHandler,
  type NotificationProvider,
} from "./notification/index.js";
import {
  createPaymentHandler,
  type PaymentClock,
  type PaymentRandom,
} from "./payment/payment-handler.js";
import { createRefundHandler } from "./payment/refund-handler.js";

/**
 * The envelope versions each subject's consumers understand. Every consumer passes them so the
 * runner's DLQ gate dead-letters a schema-invalid or unknown-version message on its first delivery,
 * before `beforeTransaction` (e.g. the payment provider call) or the handler can act on it (ADR 0011).
 */
const ENVELOPE_SCHEMAS = {
  "ta.order.placed": { 1: envelopeSchema(orderPlacedPayloadSchema) },
  "ta.order.confirmed": { 1: envelopeSchema(orderConfirmedPayloadSchema) },
  "ta.order.cancelled": { 1: envelopeSchema(orderCancelledPayloadSchema) },
  "ta.order.expired": { 1: envelopeSchema(orderExpiredPayloadSchema) },
  "ta.payment.succeeded": { 1: envelopeSchema(paymentSucceededPayloadSchema) },
  "ta.payment.failed": { 1: envelopeSchema(paymentFailedPayloadSchema) },
  "ta.payment.refund_requested": { 1: envelopeSchema(paymentRefundRequestedPayloadSchema) },
  "ta.payment.refunded": { 1: envelopeSchema(paymentRefundedPayloadSchema) },
} satisfies Record<string, Readonly<Record<number, MessageSchema>>>;

type ConsumedSubject = keyof typeof ENVELOPE_SCHEMAS;

function subscribedTo(filterSubject: ConsumedSubject) {
  return { filterSubject, schemas: ENVELOPE_SCHEMAS[filterSubject] };
}

export interface ServiceConsumerDeps {
  readonly prisma: PrismaClient;
  readonly clock: PaymentClock;
  readonly random: PaymentRandom;
  readonly newId: () => string;
  readonly latencyMs?: { readonly min: number; readonly max: number };
  /** Share of mock payment attempts that capture; the rest fail non-finally. Defaults to 1. */
  readonly paymentSuccessRate?: number;
  /** Best-effort saga counters (`payment_attempt_failed`); none when omitted. */
  readonly sagaMetrics?: SagaMetrics;
  /** The external delivery boundary; defaults to a mock that only records. */
  readonly notificationProvider?: NotificationProvider;
  readonly logger?: Logger;
}

/**
 * The durable consumers of the payment saga: mock Payment (captures and refunds), the booking saga
 * (payment results and refunds), then mock Notification for confirmations, cancellations,
 * expiries and refunds initiated and completed (spec: Messaging).
 */
export function createServiceConsumers(
  deps: ServiceConsumerDeps,
): Omit<ConsumerRunnerOptions, "bus" | "prisma" | "logger">[] {
  const loggerOption = deps.logger === undefined ? {} : { logger: deps.logger };
  const notificationSteps = createNotificationHandler({
    prisma: deps.prisma,
    provider: deps.notificationProvider ?? createMockNotificationProvider(),
    clock: deps.clock,
    newId: deps.newId,
    ...loggerOption,
  });
  const sagaHandler = createPaymentSagaHandler({
    clock: deps.clock,
    newId: deps.newId,
    ...(deps.sagaMetrics === undefined ? {} : { metrics: deps.sagaMetrics }),
    ...loggerOption,
  });
  return [
    {
      service: "payment",
      consumer: "payment",
      ...subscribedTo("ta.order.placed"),
      ...createPaymentHandler({
        clock: deps.clock,
        random: deps.random,
        newId: deps.newId,
        ...(deps.latencyMs === undefined ? {} : { latencyMs: deps.latencyMs }),
        ...(deps.paymentSuccessRate === undefined ? {} : { successRate: deps.paymentSuccessRate }),
        ...loggerOption,
      }),
    },
    {
      service: "payment",
      consumer: "payment-refund",
      ...subscribedTo("ta.payment.refund_requested"),
      handler: createRefundHandler({ clock: deps.clock, newId: deps.newId, ...loggerOption }),
    },
    {
      service: "booking",
      consumer: "booking-saga",
      ...subscribedTo("ta.payment.succeeded"),
      handler: sagaHandler,
    },
    // A durable consumer takes one filter subject; a second one keeps the first's config intact.
    {
      service: "booking",
      consumer: "booking-saga-failed",
      ...subscribedTo("ta.payment.failed"),
      handler: sagaHandler,
    },
    {
      service: "booking",
      consumer: "booking-saga-refunded",
      ...subscribedTo("ta.payment.refunded"),
      handler: sagaHandler,
    },
    {
      service: "notification",
      consumer: "notification",
      ...subscribedTo("ta.order.confirmed"),
      ...notificationSteps,
    },
    {
      service: "notification",
      consumer: "notification-cancelled",
      ...subscribedTo("ta.order.cancelled"),
      ...notificationSteps,
    },
    {
      service: "notification",
      consumer: "notification-expired",
      ...subscribedTo("ta.order.expired"),
      ...notificationSteps,
    },
    {
      service: "notification",
      consumer: "notification-refund-requested",
      ...subscribedTo("ta.payment.refund_requested"),
      ...notificationSteps,
    },
    {
      service: "notification",
      consumer: "notification-refunded",
      ...subscribedTo("ta.payment.refunded"),
      ...notificationSteps,
    },
  ];
}
