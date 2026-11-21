import { z } from "zod";

/**
 * One failed payment attempt. `final: false` is a failed attempt, not a failed checkout: only
 * `final: true` lets the booking saga cancel the order (ADR 0006).
 */
export const paymentFailedPayloadSchema = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  attemptNo: z.number().int().positive(),
  final: z.boolean(),
  reason: z.string().min(1),
});

export type PaymentFailedPayload = z.infer<typeof paymentFailedPayloadSchema>;
