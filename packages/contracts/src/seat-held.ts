import { z } from "zod";

export const seatHeldPayloadSchema = z.object({
  holdId: z.uuid(),
  eventId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1),
  holdExpiresAt: z.iso.datetime(),
});

export type SeatHeldPayload = z.infer<typeof seatHeldPayloadSchema>;
