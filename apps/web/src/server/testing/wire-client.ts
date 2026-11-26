import { type httpLink, TRPCClientError } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { ContextRequest, TRPCContext } from "../trpc";

type WireFetch = NonNullable<Parameters<typeof httpLink>[0]["fetch"]>;

export const WIRE_URL = "http://ticketarena.test/api/trpc";

/**
 * Test-only: a `fetch` for `httpLink` that hands each request to the same fetch handler as the API
 * route, so a test sees an error exactly as the browser does: after the error formatter, over the
 * wire. Only the network is replaced; the router, formatter and transformer are the real ones.
 */
export function wireFetch(
  router: AnyTRPCRouter,
  createContext: (request: ContextRequest) => Promise<TRPCContext> | TRPCContext,
): WireFetch {
  return (input, init) => {
    const { signal, ...rest } = init ?? {};
    return fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(input, { ...rest, ...(signal ? { signal } : {}) }),
      router,
      createContext: ({ req, resHeaders }) => createContext({ req, resHeaders }),
    });
  };
}

/** The client error a call rejects with; fails the test when the call succeeds or fails otherwise. */
export async function rejectionOf<TRouter extends AnyTRPCRouter>(
  call: Promise<unknown>,
): Promise<TRPCClientError<TRouter>> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TRPCClientError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}
