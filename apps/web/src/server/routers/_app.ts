import { createCallerFactory, createTRPCRouter } from "../trpc";
import { healthRouter } from "./health";

export const appRouter = createTRPCRouter({
  health: healthRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
