/** The part of a client the connection manages; a node-redis client satisfies it. */
export interface ConnectableClient {
  connect(): Promise<unknown>;
  destroy(): void;
}

export interface LazyConnectionOptions<C extends ConnectableClient> {
  /** Builds a fresh, unconnected client; called again whenever the previous one was discarded. */
  readonly create: () => C;
  /** Bound on `connect()`, handshake included (ms). */
  readonly connectTimeoutMs: number;
  /** Bound on one command, from the call until its reply (ms). */
  readonly commandTimeoutMs: number;
  /**
   * True for an error that is the server's answer (e.g. a Redis error reply): the server was
   * reached, so the error is rethrown as is. Every other failure is `RedisUnavailableError`.
   */
  readonly isServerReply: (error: unknown) => boolean;
}

/**
 * Redis could not be reached: connecting failed or timed out, the client is offline, or a command
 * got no reply in time. An error reply is not one of these, since Redis answered;
 * `admittedProcedure` relies on that difference (ADR 0008 amendment, ticket 63).
 */
export class RedisUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Redis is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "RedisUnavailableError";
  }
}

export interface LazyConnection<C> {
  /** Runs one command on the shared client, connecting it first if needed. */
  run<T>(command: (client: C) => Promise<T>): Promise<T>;
  /** Destroys the current client, if any; a later `run` connects a new one. */
  close(): void;
}

class DeadlineError extends Error {}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One client per process, connected on first use, whose every call is bounded so a stopped or
 * hung Redis fails the caller within the timeouts instead of hanging it:
 * - a connect that fails or outruns `connectTimeoutMs` destroys its client (so it never keeps
 *   reconnecting in the background) and the next call builds a new one;
 * - a command without a reply within `commandTimeoutMs` destroys the client too: its connection
 *   no longer answers, and later commands would only queue behind the lost reply. Client-level
 *   timeouts do not cover this: node-redis stops timing a command once it is written.
 * Reconnecting an established connection and refusing commands while it is down are the
 * client's own job (`create` configures it).
 */
export function createLazyConnection<C extends ConnectableClient>(
  options: LazyConnectionOptions<C>,
): LazyConnection<C> {
  let current: Promise<C> | undefined;

  const discard = (client: Promise<C>) => {
    if (current === client) {
      current = undefined;
    }
    void client.then((connected) => connected.destroy()).catch(() => undefined);
  };

  const connect = async (): Promise<C> => {
    const client = options.create();
    const connecting = client.connect();
    try {
      await withDeadline(connecting, options.connectTimeoutMs, "connect");
      return client;
    } catch (error) {
      // The attempt may still settle after the deadline; it is abandoned either way.
      connecting.catch(() => undefined);
      client.destroy();
      throw error;
    }
  };

  const connected = (): Promise<C> => {
    if (current === undefined) {
      const attempt = connect().catch((error: unknown) => {
        if (current === attempt) {
          current = undefined;
        }
        throw new RedisUnavailableError(error);
      });
      current = attempt;
    }
    return current;
  };

  return {
    async run(command) {
      const client = connected();
      const ready = await client;
      try {
        return await withDeadline(command(ready), options.commandTimeoutMs, "command");
      } catch (error) {
        if (error instanceof DeadlineError) {
          discard(client);
        }
        throw options.isServerReply(error) ? error : new RedisUnavailableError(error);
      }
    },
    close() {
      if (current !== undefined) {
        discard(current);
      }
    },
  };
}
