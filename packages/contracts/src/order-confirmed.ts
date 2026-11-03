import { z } from "zod";

/** Carries the contact because the notification service may not read booking's tables (ADR 0009). */
export const orderConfirmedPayloadSchema = z.object({
  orderId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string().min(1),
  contact: z.object({ email: z.email(), phone: z.string().min(1).optional() }),
});

export type OrderConfirmedPayload = z.infer<typeof orderConfirmedPayloadSchema>;
