import { createPaymentSagaHandler } from "@ticketarena/booking";
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

export interface ServiceConsumerDeps {
  readonly prisma: PrismaClient;
  readonly clock: PaymentClock;
  readonly random: PaymentRandom;
  readonly newId: () => string;
  readonly latencyMs?: { readonly min: number; readonly max: number };
  /** The external delivery boundary; defaults to a mock that only records. */
  readonly notificationProvider?: NotificationProvider;
  readonly logger?: Logger;
}

/** The durable consumers of the payment saga: mock Payment, the booking saga, then mock Notification (spec: Messaging). */
export function createServiceConsumers(
  deps: ServiceConsumerDeps,
): Omit<ConsumerRunnerOptions, "bus" | "prisma" | "logger">[] {
  const loggerOption = deps.logger === undefined ? {} : { logger: deps.logger };
  return [
    {
      service: "payment",
      consumer: "payment",
      filterSubject: "ta.order.placed",
      handler: createPaymentHandler({
        clock: deps.clock,
        random: deps.random,
        newId: deps.newId,
        ...(deps.latencyMs === undefined ? {} : { latencyMs: deps.latencyMs }),
        ...loggerOption,
      }),
    },
    {
      service: "booking",
      consumer: "booking-saga",
      filterSubject: "ta.payment.succeeded",
      handler: createPaymentSagaHandler({
        clock: deps.clock,
        newId: deps.newId,
        ...loggerOption,
      }),
    },
    {
      service: "notification",
      consumer: "notification",
      filterSubject: "ta.order.confirmed",
      handler: createNotificationHandler({
        prisma: deps.prisma,
        provider: deps.notificationProvider ?? createMockNotificationProvider(),
        clock: deps.clock,
        newId: deps.newId,
        ...loggerOption,
      }),
    },
  ];
}
