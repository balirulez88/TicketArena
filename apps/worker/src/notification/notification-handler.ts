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

type NotifiedEnvelope = z.infer<typeof notifiedEnvelope>;

/**
 * What makes two events the same message to the buyer. A refund step is one message per payment:
 * Payment re-announces `payment.refund_requested` and `payment.refunded` under new event ids
 * (reconciler re-emits, operator retries, repeated requests) so Booking can recover a lost
 * confirmation, and the buyer must hear about each step once. Every other event is its own message.
 */
function dedupeKey(notified: NotifiedEnvelope): string {
  switch (notified.type) {
    case "payment.refund_requested":
    case "payment.refunded":
      return `refund:${notified.payload.paymentId}:${TEMPLATES[notified.type]}`;
    default:
      return `event:${notified.id}`;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
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
  // resume it. The upsert also reads the winner's row if a concurrent delivery created it first,
  // whether that was a copy of this event or another event with the same dedupe key.
  function recordPending(
    dedupeKey: string,
    sourceEventId: string,
    channel: NotificationChannel,
    recipient: string,
    template: string,
  ) {
    return deps.prisma.notification.upsert({
      where: { dedupeKey_channel: { dedupeKey, channel } },
      create: {
        id: deps.newId(),
        sourceEventId,
        dedupeKey,
        channel,
        recipient,
        template,
        createdAt: deps.clock.now(),
      },
      update: {},
    });
  }

  function findByKey(dedupeKey: string, channel: NotificationChannel) {
    return deps.prisma.notification.findUnique({
      where: { dedupeKey_channel: { dedupeKey, channel } },
    });
  }

  /**
   * The one row this channel's message is sent under. A row already holding the key wins. Else a
   * row this same event got from a worker that wrote no key (deploy or rollback window) is promoted
   * to the key, keeping its id, because that id may already have reached the provider; without the
   * key a later re-announcement of the refund would miss it and send again under a new id. The
   * promotion is one conditional UPDATE, so of two racing deliveries only one moves the row; if
   * another delivery claimed the key first, the unique index refuses the promotion and that
   * winner's row is used instead. Otherwise a new row is created under the key.
   */
  async function rowFor(
    key: string,
    sourceEventId: string,
    channel: NotificationChannel,
    recipient: string,
    template: string,
  ) {
    const keyed = await findByKey(key, channel);
    if (keyed !== null) {
      return keyed;
    }
    const legacy = await deps.prisma.notification.findUnique({
      where: { sourceEventId_channel: { sourceEventId, channel } },
    });
    if (legacy?.dedupeKey === null) {
      if (await promote(legacy.id, key)) {
        return { ...legacy, dedupeKey: key };
      }
      // Either a concurrent copy of this event promoted the row, or another event took the key.
      const winner = await findByKey(key, channel);
      if (winner !== null) {
        return winner;
      }
    }
    return recordPending(key, sourceEventId, channel, recipient, template);
  }

  /** `true` when this call gave the keyless row the key; `false` when another delivery got there. */
  async function promote(id: string, key: string): Promise<boolean> {
    try {
      const promoted = await deps.prisma.notification.updateMany({
        where: { id, dedupeKey: null },
        data: { dedupeKey: key },
      });
      return promoted.count === 1;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async function sendPending(message: ReceivedMessage): Promise<void> {
    const notified = notifiedEnvelope.parse(JSON.parse(message.data));
    const template = TEMPLATES[notified.type];
    const key = dedupeKey(notified);
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
      const notification = await rowFor(key, notified.id, channel, recipient, template);
      if (notification.status === "SENT") {
        continue;
      }
      // A PENDING row another event created (a concurrent re-announcement) is sent again under
      // its own id, so the provider's key dedupe absorbs the overlap.
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
    // By dedupe key, not event id: the rows under the key are exactly the ones this delivery
    // handed to the provider (one per channel, a promoted legacy row included, or one a concurrent
    // re-announcement created). A legacy row whose promotion lost to another delivery keeps no key
    // and was not sent here, so it is not checkpointed.
    const sent = await tx.notification.updateMany({
      where: { status: "PENDING", dedupeKey: dedupeKey(notified) },
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
