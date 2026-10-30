import { createCallerFactory, createTRPCRouter } from "../trpc";
import { healthRouter } from "./health";
import { sessionRouter } from "./session";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  session: sessionRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
