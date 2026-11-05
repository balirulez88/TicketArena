import {
  envelopeSchema,
  type Logger,
  orderConfirmedPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";
import type { ReceivedMessage } from "@ticketarena/messaging";
import type { NotificationChannel, NotificationProvider } from "./mock-provider.js";

export interface NotificationHandlerDeps {
  /** Commits the PENDING record on its own, before the provider call, so a failed send leaves it behind. */
  readonly prisma: PrismaClient;
  readonly provider: NotificationProvider;
  readonly clock: { now(): Date };
  readonly newId: () => string;
  readonly logger?: Logger;
}

const TEMPLATE = "order-confirmation";
const orderConfirmedEnvelope = envelopeSchema(orderConfirmedPayloadSchema);

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
 * The mock Notification service. It learns everything from `order.confirmed` (ADR 0009). The
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
  function recordPending(sourceEventId: string, channel: NotificationChannel, recipient: string) {
    return deps.prisma.notification.upsert({
      where: { sourceEventId_channel: { sourceEventId, channel } },
      create: {
        id: deps.newId(),
        sourceEventId,
        channel,
        recipient,
        template: TEMPLATE,
        createdAt: deps.clock.now(),
      },
      update: {},
    });
  }

  return async function handleOrderConfirmed(
    tx: TransactionClient,
    message: ReceivedMessage,
  ): Promise<void> {
    const confirmed = orderConfirmedEnvelope.parse(JSON.parse(message.data));
    const sourceEventId = confirmed.id;

    for (const { channel, recipient } of deliveryTargets(confirmed.payload.contact)) {
      const existing = await tx.notification.findUnique({
        where: { sourceEventId_channel: { sourceEventId, channel } },
      });
      if (existing?.status === "SENT") {
        continue;
      }
      const notification = existing ?? (await recordPending(sourceEventId, channel, recipient));
      await deps.provider.send({
        idempotencyKey: notification.id,
        channel,
        recipient,
        template: TEMPLATE,
      });
      await tx.notification.update({
        where: { id: notification.id },
        data: { status: "SENT", sentAt: deps.clock.now() },
      });
      logger.info({ orderId: confirmed.payload.orderId, channel }, "notification sent");
    }
  };
}
