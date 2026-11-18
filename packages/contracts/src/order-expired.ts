import { z } from "zod";

/** Carries the contact because the notification service may not read booking's tables (ADR 0009). */
export const orderExpiredPayloadSchema = z.object({
  orderId: z.uuid(),
  contact: z.object({ email: z.email(), phone: z.string().min(1).optional() }),
});

export type OrderExpiredPayload = z.infer<typeof orderExpiredPayloadSchema>;
