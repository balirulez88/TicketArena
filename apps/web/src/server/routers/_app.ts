import { createCallerFactory, createTRPCRouter } from "../trpc";
import { bookingRouter } from "./booking";
import { eventsRouter } from "./events";
import { healthRouter } from "./health";
import { seatsRouter } from "./seats";
import { sessionRouter } from "./session";

export const appRouter = createTRPCRouter({
  booking: bookingRouter,
  events: eventsRouter,
  health: healthRouter,
  seats: seatsRouter,
  session: sessionRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
