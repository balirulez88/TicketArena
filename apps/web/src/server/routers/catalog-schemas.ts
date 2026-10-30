import { z } from "zod";

const eventIdInput = z.object({ eventId: z.uuid() });

export const eventInput = eventIdInput;
export const seatMapInput = eventIdInput;

const sectionPrice = z.object({
  id: z.uuid(),
  name: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

const eventSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  venueName: z.string(),
  onSaleAt: z.date(),
  queueOpensAt: z.date(),
  queueClosesAt: z.date(),
  demo: z.boolean(),
});

export const eventListOutput = z.array(eventSummary);

export const eventDetailOutput = eventSummary.extend({ sections: z.array(sectionPrice) });

export const seatMapOutput = z.object({
  eventId: z.uuid(),
  seats: z.array(
    z.object({
      id: z.uuid(),
      section: z.string(),
      row: z.string(),
      number: z.number().int().positive(),
      status: z.enum(["AVAILABLE", "HELD", "IN_CHECKOUT", "SOLD"]),
      priceMinor: z.number().int().nonnegative(),
      currency: z.string().length(3),
    }),
  ),
});
