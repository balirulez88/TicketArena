import {
  envelopeSchema,
  type Logger,
  orderConfirmedPayloadSchema,
  orderExpiredPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import type { ReceivedMessage } from "@ticketarena/messaging";
import { z } from "zod";
import type { NotificationChannel, NotificationProvider } from "./mock-provider.js";

export interface NotificationHandlerDeps {
  /** Commits the PENDING record on its own, before the provider call, so a failed send leaves it behind. */
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
]);
const TEMPLATES = {
  "order.confirmed": "order-confirmation",
  "order.expired": "order-expiry",
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

/**
 * The mock Notification service. It learns everything from `order.confirmed` and
 * `order.expired` (ADR 0009). The
 * PENDING record is committed before the provider is called; the SENT update rides the handler's
 * transaction. If the send or that commit fails, redelivery resumes the PENDING record and calls
 * the provider again with the same key (the notification id), so external delivery is at-least-once
 * and the provider's key dedupe, not this service, absorbs the repeat. `(sourceEventId, channel)`
 * uniqueness keeps a redelivered event from creating a second record.
 */
export function createNotificationHandler(deps: NotificationHandlerDeps) {
  const logger = deps.logger ?? silentLogger;

  // Own transaction, not the handler's: the redelivery after a failed send must find PENDING and
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

  return async function handleNotifiedEvent(
    tx: TransactionClient,
    message: ReceivedMessage,
  ): Promise<undefined> {
    const notified = notifiedEnvelope.parse(JSON.parse(message.data));
    const sourceEventId = notified.id;
    const template = TEMPLATES[notified.type];

    for (const { channel, recipient } of deliveryTargets(notified.payload.contact)) {
      const existing = await tx.notification.findUnique({
        where: { sourceEventId_channel: { sourceEventId, channel } },
      });
      if (existing?.status === "SENT") {
        continue;
      }
      const notification =
        existing ?? (await recordPending(sourceEventId, channel, recipient, template));
      await deps.provider.send({
        idempotencyKey: notification.id,
        channel,
        recipient,
        template: notification.template,
      });
      await tx.notification.update({
        where: { id: notification.id },
        data: { status: "SENT", sentAt: deps.clock.now() },
      });
      logger.info({ orderId: notified.payload.orderId, channel, template }, "notification sent");
    }
  };
}
