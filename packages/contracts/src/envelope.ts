import { z } from "zod";

/**
 * Every integration event travels in this envelope. `correlationId` is minted once at
 * `holdSeats` and never changes for the whole booking, so a single id traces a purchase across
 * services; `causationId` points at the event that directly caused this one.
 */
export function envelopeSchema<Payload extends z.ZodType>(payload: Payload) {
  return z.object({
    id: z.uuid(),
    type: z.string().min(1),
    version: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    correlationId: z.uuid(),
    causationId: z.uuid().nullable(),
    holdId: z.uuid().optional(),
    orderId: z.uuid().optional(),
    payload,
  });
}

export type Envelope<Payload> = {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  holdId?: string;
  orderId?: string;
  payload: Payload;
};
