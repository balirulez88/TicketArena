import { createTRPCRouter, publicProcedure } from "../trpc";

export const sessionRouter = createTRPCRouter({
  whoami: publicProcedure.query(({ ctx }) => ctx.principal),
});
