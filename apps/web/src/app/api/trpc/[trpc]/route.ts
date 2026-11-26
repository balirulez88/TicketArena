import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext, onProcedureError } from "@/server/trpc";

function handler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: ({ resHeaders }) => createTRPCContext({ req: request, resHeaders }),
    onError: onProcedureError,
  });
}

export { handler as GET, handler as POST };
