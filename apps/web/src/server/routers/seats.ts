import { createTRPCRouter, publicProcedure } from "../trpc";
import { seatMapInput, seatMapOutput } from "./catalog-schemas";
import { eventNotFound } from "./event-not-found";

export const seatsRouter = createTRPCRouter({
  map: publicProcedure
    .input(seatMapInput)
    .output(seatMapOutput)
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { id: input.eventId },
        select: { id: true },
      });
      if (event === null) {
        throw eventNotFound(input.eventId);
      }
      const seats = await ctx.db.seat.findMany({
        where: { eventId: event.id },
        include: { row: { include: { section: true } } },
        orderBy: [
          { row: { section: { name: "asc" } } },
          { row: { label: "asc" } },
          { number: "asc" },
        ],
      });
      return {
        eventId: event.id,
        seats: seats.map((seat) => ({
          id: seat.id,
          section: seat.row.section.name,
          row: seat.row.label,
          number: seat.number,
          status: seat.status,
          priceMinor: seat.row.section.priceMinor,
          currency: seat.row.section.currency,
        })),
      };
    }),
});
