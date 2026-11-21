import { z } from "zod";

/**
 * A durable refund obligation for one captured payment (spec: Refund obligations). Carries the
 * contact because neither the Payment nor the Notification service may read booking's tables
 * (ADR 0009). `contact` is absent only for `unknown_order`: the order, and with it the contact,
 * no longer exists, yet the money must still go back.
 */
export const paymentRefundRequestedPayloadSchema = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  reason: z.enum([
    "late_capture",
    "late_delivery",
    "order_expired",
    "order_cancelled",
    "order_confirmed",
    "amount_mismatch",
    "unknown_order",
  ]),
  contact: z.object({ email: z.email(), phone: z.string().min(1).optional() }).optional(),
});

export type PaymentRefundRequestedPayload = z.infer<typeof paymentRefundRequestedPayloadSchema>;
