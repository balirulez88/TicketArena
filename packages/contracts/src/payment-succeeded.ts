import { z } from "zod";

/** `capturedAt` is the provider's capture time, distinct from when the event is delivered. */
export const paymentSucceededPayloadSchema = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  attemptNo: z.number().int().positive(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  capturedAt: z.iso.datetime(),
});

export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayloadSchema>;
