import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";

/**
 * How the stand-in answers on its port:
 * - `forward`: a transparent TCP proxy to the real Redis;
 * - `silent`: accepts connections and reads them, but never answers (a hung or blackholed Redis);
 * - `closed`: nothing listens, so connections are refused (a stopped Redis).
 */
export type RedisStandInMode = "forward" | "silent" | "closed";

/**
 * A local TCP listener in front of the real test Redis that a test can switch between reachable,
 * hung and stopped, on one fixed port, so a client sees the same Redis go away and come back.
 */
export interface RedisStandIn {
  /** The real Redis URL with its host and port replaced by the stand-in's. */
  readonly url: string;
  /** Switches the mode; existing connections are dropped, or go silent for `silent`. */
  setMode(mode: RedisStandInMode): Promise<void>;
  /** Client connections currently open on the stand-in. */
  openConnections(): number;
  close(): Promise<void>;
}

export async function startRedisStandIn(
  targetUrl: string,
  initialMode: RedisStandInMode = "forward",
): Promise<RedisStandIn> {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port === "" ? "6379" : target.port);
  const clients = new Map<Socket, Socket | undefined>();
  let mode: RedisStandInMode = initialMode;

  const accept = (client: Socket) => {
    client.on("error", () => client.destroy());
    client.on("close", () => {
      clients.get(client)?.destroy();
      clients.delete(client);
    });
    if (mode !== "forward") {
      clients.set(client, undefined);
      client.resume();
      return;
    }
    const upstream = tcpConnect(targetPort, target.hostname);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    clients.set(client, upstream);
    client.pipe(upstream);
    upstream.pipe(client);
  };

  let server: Server | undefined;
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const listening = createServer(accept);
      listening.once("error", reject);
      listening.listen(port, "127.0.0.1", () => {
        server = listening;
        const address = listening.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  const stopListening = () =>
    new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = undefined;
    });

  const port = await listen(0);
  if (initialMode === "closed") {
    await stopListening();
  }
  const url = new URL(targetUrl);
  url.hostname = "127.0.0.1";
  url.port = String(port);

  return {
    url: url.toString(),
    async setMode(next) {
      mode = next;
      for (const [client, upstream] of clients) {
        if (next === "silent" && upstream !== undefined) {
          // The connection stays open but nothing comes back: a Redis that stopped answering.
          upstream.unpipe(client);
          client.unpipe(upstream);
          upstream.removeAllListeners("close");
          upstream.destroy();
          clients.set(client, undefined);
          client.resume();
        } else if (next !== "silent") {
          client.destroy();
        }
      }
      if (next === "closed") {
        await stopListening();
      } else if (server === undefined) {
        await listen(port);
      }
    },
    openConnections: () => clients.size,
    async close() {
      for (const client of clients.keys()) {
        client.destroy();
      }
      await stopListening();
    },
  };
}
