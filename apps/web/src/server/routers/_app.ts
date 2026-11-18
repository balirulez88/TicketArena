import { createCallerFactory, createTRPCRouter } from "../trpc";
import { adminRouter } from "./admin";
import { bookingRouter } from "./booking";
import { eventsRouter } from "./events";
import { healthRouter } from "./health";
import { queueRouter } from "./queue";
import { seatsRouter } from "./seats";
import { sessionRouter } from "./session";

export const appRouter = createTRPCRouter({
  admin: adminRouter,
  booking: bookingRouter,
  events: eventsRouter,
  health: healthRouter,
  queue: queueRouter,
  seats: seatsRouter,
  session: sessionRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
