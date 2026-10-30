import { createTRPCRouter, publicProcedure } from "../trpc";
import { eventDetailOutput, eventInput, eventListOutput } from "./catalog-schemas";
import { eventNotFound } from "./event-not-found";

export const eventsRouter = createTRPCRouter({
  list: publicProcedure.output(eventListOutput).query(async ({ ctx }) => {
    const events = await ctx.db.event.findMany({
      include: { venue: true },
      orderBy: [{ onSaleAt: "asc" }, { name: "asc" }],
    });
    return events.map(({ venue, ...event }) => ({ ...event, venueName: venue.name }));
  }),

  get: publicProcedure
    .input(eventInput)
    .output(eventDetailOutput)
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { id: input.eventId },
        include: { venue: { include: { sections: { orderBy: { priceMinor: "desc" } } } } },
      });
      if (event === null) {
        throw eventNotFound(input.eventId);
      }
      const { venue, ...fields } = event;
      return { ...fields, venueName: venue.name, sections: venue.sections };
    }),
});
