import { z } from "zod";

/**
 * The Payment service has returned the money of one captured payment (spec: Refund obligations).
 * Carries the contact of the request it executes, so Notification never reads booking's tables
 * (ADR 0009); like the request, it is absent only for an `unknown_order` refund.
 */
export const paymentRefundedPayloadSchema = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  refundedAt: z.iso.datetime(),
  contact: z.object({ email: z.email(), phone: z.string().min(1).optional() }).optional(),
});

export type PaymentRefundedPayload = z.infer<typeof paymentRefundedPayloadSchema>;
