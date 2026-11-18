import { z } from "zod";

/** `seatIds` are the seats this release freed; may be empty if every seat was taken over. */
export const holdReleasedPayloadSchema = z.object({
  holdId: z.uuid(),
  seatIds: z.array(z.uuid()),
});

export type HoldReleasedPayload = z.infer<typeof holdReleasedPayloadSchema>;
