import { createPaymentSagaHandler, type SagaMetrics } from "@ticketarena/booking";
import type { Logger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import type { ConsumerRunnerOptions } from "@ticketarena/messaging";
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
  const notificationHandler = createNotificationHandler({
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
      filterSubject: "ta.order.placed",
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
      filterSubject: "ta.payment.refund_requested",
      handler: createRefundHandler({ clock: deps.clock, newId: deps.newId, ...loggerOption }),
    },
    {
      service: "booking",
      consumer: "booking-saga",
      filterSubject: "ta.payment.succeeded",
      handler: sagaHandler,
    },
    // A durable consumer takes one filter subject; a second one keeps the first's config intact.
    {
      service: "booking",
      consumer: "booking-saga-failed",
      filterSubject: "ta.payment.failed",
      handler: sagaHandler,
    },
    {
      service: "booking",
      consumer: "booking-saga-refunded",
      filterSubject: "ta.payment.refunded",
      handler: sagaHandler,
    },
    {
      service: "notification",
      consumer: "notification",
      filterSubject: "ta.order.confirmed",
      handler: notificationHandler,
    },
    {
      service: "notification",
      consumer: "notification-cancelled",
      filterSubject: "ta.order.cancelled",
      handler: notificationHandler,
    },
    {
      service: "notification",
      consumer: "notification-expired",
      filterSubject: "ta.order.expired",
      handler: notificationHandler,
    },
    {
      service: "notification",
      consumer: "notification-refund-requested",
      filterSubject: "ta.payment.refund_requested",
      handler: notificationHandler,
    },
    {
      service: "notification",
      consumer: "notification-refunded",
      filterSubject: "ta.payment.refunded",
      handler: notificationHandler,
    },
  ];
}
