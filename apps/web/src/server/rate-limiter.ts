/** The spec's limit for the destructive demo actions: one call per action per 10 s. */
export const ADMIN_ACTION_WINDOW_MS = 10_000;

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

/** One call per action per window, across every server instance (the state lives in Redis). */
export interface RateLimiter {
  acquire(action: string): Promise<RateLimitDecision>;
}

/** The two Redis commands the limiter needs: `SET key value NX PX ms` and `PTTL key`. */
export interface RateLimitClient {
  /** `true` when the key was set, `false` when it already existed. */
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  pTtl(key: string): Promise<number>;
}

interface RateLimiterOptions {
  readonly prefix: string;
  readonly windowMs: number;
}

export function createRedisRateLimiter(
  client: RateLimitClient,
  { prefix, windowMs }: RateLimiterOptions,
): RateLimiter {
  return {
    async acquire(action) {
      const key = `${prefix}admin:rate:${action}`;
      // SET NX is the whole decision, atomically: whoever creates the key owns the window, and the
      // key's own expiry ends it, so no clock is read here and no instance can disagree.
      if (await client.setNxPx(key, "1", windowMs)) {
        return { allowed: true };
      }
      // The key may expire between the two commands; a zero wait then simply means "retry now".
      return { allowed: false, retryAfterMs: Math.max(await client.pTtl(key), 0) };
    },
  };
}

/** The limiter behind `admin.runRace` and `admin.resetDemo`: global per action, not per session. */
export function createAdminRateLimiter(client: RateLimitClient, prefix = ""): RateLimiter {
  return createRedisRateLimiter(client, { prefix, windowMs: ADMIN_ACTION_WINDOW_MS });
}
