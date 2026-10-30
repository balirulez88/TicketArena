import { z } from "zod";

export const orderPlacedPayloadSchema = z.object({
  orderId: z.uuid(),
  holdId: z.uuid(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().min(1),
  paymentDeadline: z.iso.datetime(),
  contact: z.object({ email: z.email(), phone: z.string().min(1).optional() }),
});

export type OrderPlacedPayload = z.infer<typeof orderPlacedPayloadSchema>;
