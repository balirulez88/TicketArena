import { randomUUID } from "node:crypto";
import { type Logger, silentLogger } from "@ticketarena/contracts";
import { setupRedisStandIn, setupTestRedis } from "@ticketarena/test-infra";
import { RedisUnavailableError } from "@ticketarena/waiting-room";
import { describe, expect, test } from "vitest";
import { createLazyQueueStore } from "./queue-store";

const redis = setupTestRedis();

describe("createLazyQueueStore", () => {
  test("connects to REDIS_URL on first use and hands out one shared store", async () => {
    const queueStore = createLazyQueueStore({
      readEnv: () => ({ REDIS_URL: redis.url }),
      logger: silentLogger,
      prefix: redis.prefix,
    });
    const eventId = randomUUID();

    const store = await queueStore();
    await store.join(eventId, "a", { kind: "SEQUENCE" }, new Date());

    expect(await queueStore()).toBe(store);
    expect(await (await queueStore()).position(eventId, "a")).toBe(1);
  });

  test("an invalid REDIS_URL fails naming the variable, is logged once and is not re-read", async () => {
    const errors: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (_fields, message) => {
        errors.push(message ?? "");
      },
    };
    let reads = 0;
    const queueStore = createLazyQueueStore({
      readEnv: () => {
        reads += 1;
        return { REDIS_URL: "https://not-redis.example" };
      },
      logger,
      prefix: "",
    });

    await expect(queueStore()).rejects.toThrow(/REDIS_URL/);
    await expect(queueStore()).rejects.toThrow(/REDIS_URL/);

    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("createLazyQueueStore during a Redis outage", () => {
  const standIn = setupRedisStandIn();
  // Roomy enough for a loaded machine; each test proves the call ends near these bounds.
  const TIMEOUT_MS = 2000;
  // Generous against a slow CI machine, yet far below the 30 s test timeout a hang would hit.
  const BOUND_MS = 15_000;

  function outageStore(logger: Logger = silentLogger) {
    return createLazyQueueStore({
      readEnv: () => ({
        REDIS_URL: standIn.url,
        REDIS_CONNECT_TIMEOUT_MS: String(TIMEOUT_MS),
        REDIS_COMMAND_TIMEOUT_MS: String(TIMEOUT_MS),
      }),
      logger,
      prefix: standIn.prefix,
    });
  }

  /** Runs `call` and reports how it settled and how long it took. */
  async function timed(call: () => Promise<unknown>) {
    const started = performance.now();
    const outcome = await call().then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    return { ...outcome, elapsedMs: performance.now() - started };
  }

  test("with Redis stopped, a call fails fast as RedisUnavailableError", async () => {
    await standIn.setMode("closed");
    const store = await outageStore()();

    const { error, elapsedMs } = await timed(() => store.position(randomUUID(), "a"));

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(elapsedMs).toBeLessThan(BOUND_MS);
  });

  test("a Redis that never answers fails the first connect within the connect timeout; the client is destroyed and replaced on the next use", async () => {
    await standIn.setMode("silent");
    const store = await outageStore()();
    const eventId = randomUUID();

    const { error, elapsedMs } = await timed(() =>
      store.join(eventId, "a", { kind: "SEQUENCE" }, new Date()),
    );

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsedMs).toBeLessThan(BOUND_MS);
    // Destroyed: the half-open connection is closed, not left to reconnect in the background.
    await expect.poll(() => standIn.openConnections()).toBe(0);

    await standIn.setMode("forward");
    await store.join(eventId, "a", { kind: "SEQUENCE" }, new Date());
    expect(await store.position(eventId, "a")).toBe(1);
  });

  test("a connected client whose Redis stops answering fails a command within the command timeout", async () => {
    await standIn.setMode("forward");
    const store = await outageStore()();
    const eventId = randomUUID();
    await store.join(eventId, "a", { kind: "SEQUENCE" }, new Date());

    await standIn.setMode("silent");
    const { error, elapsedMs } = await timed(() => store.position(eventId, "a"));

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(elapsedMs).toBeLessThan(BOUND_MS);
  });

  test("a connected client queues no command while Redis is down and works again once it is back", async () => {
    const errors: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (_fields, message) => {
        errors.push(message ?? "");
      },
    };
    await standIn.setMode("forward");
    const store = await outageStore(logger)();
    const eventId = randomUUID();
    await store.join(eventId, "a", { kind: "SEQUENCE" }, new Date());

    await standIn.setMode("closed");
    const { error, elapsedMs } = await timed(() => store.position(eventId, "a"));

    expect(error).toBeInstanceOf(RedisUnavailableError);
    // Not queued for the reconnect: the call fails well before the connect timeout would pass.
    expect(elapsedMs).toBeLessThan(TIMEOUT_MS);
    await expect.poll(() => errors.length).toBeGreaterThan(0);

    await standIn.setMode("forward");
    await expect
      .poll(() => store.position(eventId, "a").catch(() => "unavailable"), { timeout: BOUND_MS })
      .toBe(1);
  });
});
