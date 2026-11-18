import { createHash } from "node:crypto";
import type { QueueStore } from "./ports";
import {
  JOIN_SCRIPT,
  joinScoreArgument,
  LEAVE_SCRIPT,
  queueKeys,
  toInteger,
} from "./queue-scripts";

const DEFAULT_TIMEOUT_MS = 2000;

export interface UpstashQueueStoreOptions {
  /** Upstash REST URL; the app validates and injects it. */
  readonly url: string;
  readonly token: string;
  /** Prepended to every key, so environments and test files can share one database. */
  readonly prefix: string;
  /** Per-request timeout; defaults to 2 seconds. */
  readonly timeoutMs?: number;
}

interface Script {
  readonly source: string;
  readonly sha: string;
}

function script(source: string): Script {
  return { source, sha: createHash("sha1").update(source).digest("hex") };
}

const JOIN = script(JOIN_SCRIPT);
const LEAVE = script(LEAVE_SCRIPT);

class UpstashCommandError extends Error {
  constructor(
    command: string,
    readonly reason: string,
  ) {
    super(`Upstash ${command} failed: ${reason}`);
    this.name = "UpstashCommandError";
  }
}

/**
 * `QueueStore` over the Upstash REST API (plain `fetch`, one HTTP request per command), running
 * the same scripts and key layout as the node-redis adapter (`queue-scripts.ts`). Scripts go as
 * EVALSHA, so the script text is sent only when the server's script cache lacks it (NOSCRIPT).
 * Errors name the command and the cause, never the token.
 */
export function createUpstashQueueStore(options: UpstashQueueStoreOptions): QueueStore {
  async function command(args: readonly string[]): Promise<unknown> {
    const name = args[0] ?? "";
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new UpstashCommandError(name, `request did not complete (${reason})`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body === "object" && body !== null && "error" in body) {
      throw new UpstashCommandError(name, String(body.error));
    }
    if (!response.ok || typeof body !== "object" || body === null || !("result" in body)) {
      throw new UpstashCommandError(name, `HTTP ${response.status}`);
    }
    return body.result;
  }

  async function runScript(
    script: Script,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args];
    try {
      return await command(["EVALSHA", script.sha, ...tail]);
    } catch (error) {
      if (error instanceof UpstashCommandError && error.reason.startsWith("NOSCRIPT")) {
        return command(["EVAL", script.source, ...tail]);
      }
      throw error;
    }
  }

  return {
    async join(eventId, member, score) {
      const keys = queueKeys(options.prefix, eventId);
      const rank = await runScript(
        JOIN,
        [keys.queue, keys.sequence],
        [member, joinScoreArgument(score)],
      );
      return toInteger(rank, "join") + 1;
    },

    async position(eventId, member) {
      const rank = await command(["ZRANK", queueKeys(options.prefix, eventId).queue, member]);
      return rank === null ? null : toInteger(rank, "position") + 1;
    },

    async leave(eventId, member) {
      const removed = await runScript(LEAVE, [queueKeys(options.prefix, eventId).queue], [member]);
      return toInteger(removed, "leave") === 1;
    },
  };
}
