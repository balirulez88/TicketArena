import {
  envelopeSchema,
  type Logger,
  orderCancelledPayloadSchema,
  orderConfirmedPayloadSchema,
  orderExpiredPayloadSchema,
  paymentRefundedPayloadSchema,
  paymentRefundRequestedPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import type { ConsumerRunnerOptions, ReceivedMessage } from "@ticketarena/messaging";
import { z } from "zod";
import type { NotificationChannel, NotificationProvider } from "./mock-provider.js";

export interface NotificationHandlerDeps {
  /** Commits the PENDING record on its own, outside any transaction the provider call could hold open. */
  readonly prisma: PrismaClient;
  readonly provider: NotificationProvider;
  readonly clock: { now(): Date };
  readonly newId: () => string;
  readonly logger?: Logger;
}

/** The events this service tells the buyer about, each with the template it is sent with. */
const notifiedEnvelope = z.discriminatedUnion("type", [
  envelopeSchema(orderConfirmedPayloadSchema).extend({
    type: z.literal("order.confirmed"),
  }),
  envelopeSchema(orderExpiredPayloadSchema).extend({ type: z.literal("order.expired") }),
  envelopeSchema(orderCancelledPayloadSchema).extend({ type: z.literal("order.cancelled") }),
  envelopeSchema(paymentRefundRequestedPayloadSchema).extend({
    type: z.literal("payment.refund_requested"),
  }),
  envelopeSchema(paymentRefundedPayloadSchema).extend({ type: z.literal("payment.refunded") }),
]);
const TEMPLATES = {
  "order.confirmed": "order-confirmation",
  "order.expired": "order-expiry",
  "order.cancelled": "order-cancellation",
  "payment.refund_requested": "refund-initiated",
  "payment.refunded": "refund-completed",
} as const;

/** One email always; an SMS only when the buyer gave a phone number. */
function deliveryTargets(contact: {
  readonly email: string;
  readonly phone?: string | undefined;
}): { channel: NotificationChannel; recipient: string }[] {
  return [
    { channel: "EMAIL", recipient: contact.email },
    ...(contact.phone === undefined ? [] : [{ channel: "SMS" as const, recipient: contact.phone }]),
  ];
}

export type NotificationConsumerSteps = Required<
  Pick<ConsumerRunnerOptions, "beforeTransaction" | "handler">
>;

/**
 * The mock Notification service. It learns everything from `order.confirmed`,
 * `order.cancelled`, `order.expired`, `payment.refund_requested` (refund initiated) and
 * `payment.refunded` (refund completed) (ADR 0009). Spread the result into a consumer runner bound
 * to `service: "notification"`.
 *
 * Three steps, and the provider call is in none of the transactions (TD-051): awaited inside the
 * runner's transaction, a slow provider would pin a pooled connection and, past the
 * interactive-transaction timeout, roll back and redeliver forever. `beforeTransaction` commits
 * a PENDING record per channel on its own, then sends; the runner's transaction (with the dedupe
 * row) records the outcome as SENT. A crash or failure anywhere before that commit redelivers the
 * message, which resumes the PENDING records and sends again with the same key (the notification
 * id): external delivery is at-least-once and the provider's key dedupe, not this service,
 * absorbs the repeat. `(sourceEventId, channel)` uniqueness keeps a redelivered event from
 * creating a second record.
 */
export function createNotificationHandler(
  deps: NotificationHandlerDeps,
): NotificationConsumerSteps {
  const logger = deps.logger ?? silentLogger;

  // Own transaction, not the runner's: the redelivery after a failed send must find PENDING and
  // resume it. The upsert also reads the winner's row if a concurrent delivery created it first.
  function recordPending(
    sourceEventId: string,
    channel: NotificationChannel,
    recipient: string,
    template: string,
  ) {
    return deps.prisma.notification.upsert({
      where: { sourceEventId_channel: { sourceEventId, channel } },
      create: {
        id: deps.newId(),
        sourceEventId,
        channel,
        recipient,
        template,
        createdAt: deps.clock.now(),
      },
      update: {},
    });
  }

  async function sendPending(message: ReceivedMessage): Promise<void> {
    const notified = notifiedEnvelope.parse(JSON.parse(message.data));
    const template = TEMPLATES[notified.type];
    const contact = notified.payload.contact;
    // Only an `unknown_order` refund has no contact: the order and its buyer are gone, so there is
    // no one to tell. Acked, not retried; no redelivery could ever supply a recipient.
    if (contact === undefined) {
      logger.info(
        { orderId: notified.payload.orderId, template },
        "notification skipped: no contact",
      );
      return;
    }
    for (const { channel, recipient } of deliveryTargets(contact)) {
      const existing = await deps.prisma.notification.findUnique({
        where: { sourceEventId_channel: { sourceEventId: notified.id, channel } },
      });
      if (existing?.status === "SENT") {
        continue;
      }
      const notification =
        existing ?? (await recordPending(notified.id, channel, recipient, template));
      await deps.provider.send({
        idempotencyKey: notification.id,
        channel,
        recipient,
        template: notification.template,
      });
    }
  }

  // Reached only after `sendPending` resolved for this delivery, so every PENDING record of the
  // event has been handed to the provider; committing SENT with the dedupe row checkpoints both.
  async function recordSent(tx: TransactionClient, message: ReceivedMessage): Promise<undefined> {
    const notified = notifiedEnvelope.parse(JSON.parse(message.data));
    const sent = await tx.notification.updateMany({
      where: { sourceEventId: notified.id, status: "PENDING" },
      data: { status: "SENT", sentAt: deps.clock.now() },
    });
    if (sent.count > 0) {
      logger.info(
        {
          orderId: notified.payload.orderId,
          template: TEMPLATES[notified.type],
          channels: sent.count,
        },
        "notification sent",
      );
    }
    return undefined;
  }

  return { beforeTransaction: sendPending, handler: recordSent };
}
