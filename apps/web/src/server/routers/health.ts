import { createTRPCRouter, publicProcedure } from "../trpc";

export const healthRouter = createTRPCRouter({
  check: publicProcedure.query(({ ctx }) => ({
    status: "ok" as const,
    checkedAt: ctx.now(),
  })),
});
