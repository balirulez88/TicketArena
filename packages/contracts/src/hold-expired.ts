import { z } from "zod";

/** `seatIds` are the seats this expiry freed; may be empty if every seat was taken over lazily. */
export const holdExpiredPayloadSchema = z.object({
  holdId: z.uuid(),
  seatIds: z.array(z.uuid()),
});

export type HoldExpiredPayload = z.infer<typeof holdExpiredPayloadSchema>;
