import type { JoinScore } from "./ports";

// Shared by every `QueueStore` adapter, so the node-redis and Upstash adapters run the same Lua
// against the same key layout (the contract suite proves they behave the same).

/**
 * Keys per event; the `{eventId}` hash tag keeps them in one cluster slot, which multi-key
 * scripts require.
 * - `<prefix>waiting-room:{<eventId>}:queue`: ZSET, member = session id, score = join score.
 * - `<prefix>waiting-room:{<eventId>}:seq`: counter behind the `1 + sequence` scores.
 */
export function queueKeys(prefix: string, eventId: string) {
  return {
    queue: `${prefix}waiting-room:{${eventId}}:queue`,
    sequence: `${prefix}waiting-room:{${eventId}}:seq`,
  };
}

// The ZSCORE guard draws a sequence number only for a new member, so re-joins leave no gaps;
// ZADD NX is what guarantees an existing score is never overwritten. INCR, ZADD and ZRANK run in
// one script, so concurrent joins get distinct, increasing scores and an exact position.
// KEYS: queue, sequence. ARGV: member, pre-queue score ('' for a later join). Returns the rank.
export const JOIN_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local score = ARGV[2]
  if score == '' then
    score = 1 + redis.call('INCR', KEYS[2])
  end
  redis.call('ZADD', KEYS[1], 'NX', score, ARGV[1])
end
return redis.call('ZRANK', KEYS[1], ARGV[1])
`;

// KEYS: queue. ARGV: member. Returns 1 when the member was queued.
export const LEAVE_SCRIPT = "return redis.call('ZREM', KEYS[1], ARGV[1])";

export function joinScoreArgument(score: JoinScore): string {
  return score.kind === "PRE_QUEUE" ? String(score.score) : "";
}

export function toInteger(reply: unknown, script: string): number {
  if (typeof reply !== "number" || !Number.isInteger(reply)) {
    throw new Error(`waiting-room ${script} script returned ${String(reply)}, expected an integer`);
  }
  return reply;
}
