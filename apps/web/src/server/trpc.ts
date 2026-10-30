import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { parseServerEnv } from "./env";
import { type CookieReader, createIdentityService, type Principal } from "./identity/identity";

/**
 * Per-request context. Infrastructure (clock, and later db/redis/outbox) is injected here
 * instead of imported inside procedures, so routers stay pure functions of their context and
 * tests can drive them through `createCaller` with deterministic fakes.
 */
export interface TRPCContext {
  readonly now: () => Date;
  /** Resolved once per request; procedures never read cookies themselves (ADR 0012). */
  readonly principal: Principal;
}

export async function createTRPCContext({ req }: { req: Request }): Promise<TRPCContext> {
  const identity = createIdentityService({
    sessionSecret: parseServerEnv(process.env).SESSION_SECRET,
  });
  const principal = await identity.resolve(cookieReader(req.headers.get("cookie")));
  return { now: () => new Date(), principal };
}

// Parsed by hand: the tRPC fetch adapter hands us a plain Request, not Next's cookie store, and
// IdentityService only needs the narrow CookieReader seam.
function cookieReader(header: string | null): CookieReader {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
  return {
    get: (name: string) => {
      const value = cookies.get(name);
      return value === undefined ? undefined : { value };
    },
  };
}

const t = initTRPC.context<TRPCContext>().create({
  // superjson keeps Date/Map/BigInt intact across the wire (booking timestamps, prices).
  transformer: superjson,
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
