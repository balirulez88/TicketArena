import { setupRedisStandIn } from "@ticketarena/test-infra";
import { createClient, ErrorReply } from "redis";
import { describe, expect, test } from "vitest";
import { createLazyConnection, RedisUnavailableError } from "./index";

const standIn = setupRedisStandIn();

// The production default, roomy enough for a loaded machine; each test proves a call ends near
// these bounds instead of hanging.
const TIMEOUT_MS = 2000;
// Generous against a slow CI machine, yet far below the 30 s test timeout a hang would hit.
const BOUND_MS = 15_000;

function lazy() {
  let created = 0;
  const connection = createLazyConnection({
    create: () => {
      created += 1;
      const client = createClient({
        url: standIn.url,
        disableOfflineQueue: true,
        // A failed first connect ends `connect()` instead of retrying, as in the apps.
        socket: { reconnectStrategy: false },
      });
      client.on("error", () => undefined);
      return client;
    },
    connectTimeoutMs: TIMEOUT_MS,
    commandTimeoutMs: TIMEOUT_MS,
    isServerReply: (error) => error instanceof ErrorReply,
  });
  return { run: connection.run, close: connection.close, created: () => created };
}

async function timed(call: () => Promise<unknown>) {
  const started = performance.now();
  const error = await call().then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return { error, elapsedMs: performance.now() - started };
}

describe("createLazyConnection", () => {
  test("creates no client until the first command, then shares one", async () => {
    await standIn.setMode("forward");
    const { run, created } = lazy();
    expect(created()).toBe(0);

    expect(await run((client) => client.ping())).toBe("PONG");
    expect(await run((client) => client.ping())).toBe("PONG");

    expect(created()).toBe(1);
  });

  test("with Redis stopped, the first command fails fast as RedisUnavailableError", async () => {
    await standIn.setMode("closed");
    const { run } = lazy();

    const { error, elapsedMs } = await timed(() => run((client) => client.ping()));

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(elapsedMs).toBeLessThan(BOUND_MS);
  });

  test("a connect that never completes fails at the connect timeout, its client is destroyed and the next use builds a new one", async () => {
    await standIn.setMode("silent");
    const { run, created } = lazy();

    const { error, elapsedMs } = await timed(() => run((client) => client.ping()));

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsedMs).toBeLessThan(BOUND_MS);
    await expect.poll(() => standIn.openConnections()).toBe(0);

    await standIn.setMode("forward");
    expect(await run((client) => client.ping())).toBe("PONG");
    expect(created()).toBe(2);
  });

  test("a command without a reply fails at the command timeout and its client is replaced", async () => {
    await standIn.setMode("forward");
    const { run, created } = lazy();
    await run((client) => client.ping());

    await standIn.setMode("silent");
    const { error, elapsedMs } = await timed(() => run((client) => client.ping()));

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(elapsedMs).toBeLessThan(BOUND_MS);
    await expect.poll(() => standIn.openConnections()).toBe(0);

    await standIn.setMode("forward");
    expect(await run((client) => client.ping())).toBe("PONG");
    expect(created()).toBe(2);
  });

  test("close destroys the client and a later command connects a new one", async () => {
    await standIn.setMode("forward");
    const { run, close, created } = lazy();
    await run((client) => client.ping());

    close();

    await expect.poll(() => standIn.openConnections()).toBe(0);
    expect(await run((client) => client.ping())).toBe("PONG");
    expect(created()).toBe(2);
  });

  test("an error reply is Redis answering, rethrown as is", async () => {
    await standIn.setMode("forward");
    const { run } = lazy();

    const { error } = await timed(() =>
      run((client) => client.eval("return redis.error_reply('NOPE refused')")),
    );

    expect(error).toBeInstanceOf(ErrorReply);
    expect(error).not.toBeInstanceOf(RedisUnavailableError);
  });
});
