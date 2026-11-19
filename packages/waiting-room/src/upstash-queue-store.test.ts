import { randomUUID } from "node:crypto";
import { setupTestUpstash } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { createUpstashQueueStore } from "./index";
import { describeQueueStoreContract } from "./queue-store-contract";

const T0 = new Date("2027-05-01T10:00:00.000Z");

const upstash = setupTestUpstash();

function storeWith(prefix: string, token = upstash.token) {
  return createUpstashQueueStore({ url: upstash.url, token, prefix });
}

describeQueueStoreContract("Upstash REST", upstash.prefix, {
  store: (prefix) => storeWith(prefix),
  // Every REST call is its own HTTP request, so separate stores never share a connection.
  independentStores: async (prefix, count) => ({
    stores: Array.from({ length: count }, () => storeWith(prefix)),
    close() {
      // Nothing to release: the REST adapter holds no connection.
    },
  }),
});

describe("UpstashQueueStore", () => {
  test("a pre-queue join stores its random score and a later join stores 1 + sequence, under the prefix", async () => {
    const namespace = `${upstash.prefix}layout:`;
    const store = storeWith(namespace);
    const eventId = randomUUID();

    await store.join(eventId, "early", { kind: "PRE_QUEUE", score: 0.25 }, T0);
    await store.join(eventId, "late-1", { kind: "SEQUENCE" }, T0);
    await store.join(eventId, "late-1", { kind: "SEQUENCE" }, T0);
    await store.join(eventId, "late-2", { kind: "SEQUENCE" }, T0);

    const queueKey = `${namespace}waiting-room:{${eventId}}:queue`;
    expect(await upstash.command(["ZRANGE", queueKey, 0, -1, "WITHSCORES"])).toEqual([
      "early",
      "0.25",
      "late-1",
      "2",
      "late-2",
      "3",
    ]);
    const keys = await upstash.command(["KEYS", `*${eventId}*`]);
    expect(keys).toHaveLength(2);
    expect(Array.isArray(keys) && keys.every((key) => String(key).startsWith(namespace))).toBe(
      true,
    );
  });

  test("scripts still run after the server's script cache is flushed (EVALSHA falls back to EVAL)", async () => {
    const store = storeWith(`${upstash.prefix}flush:`);
    const eventId = randomUUID();
    expect(await store.join(eventId, "a", { kind: "SEQUENCE" }, T0)).toEqual({
      status: "QUEUED",
      position: 1,
    });

    await upstash.command(["SCRIPT", "FLUSH"]);

    expect(await store.join(eventId, "b", { kind: "SEQUENCE" }, T0)).toEqual({
      status: "QUEUED",
      position: 2,
    });
    expect(await store.leave(eventId, "a")).toBe(true);
  });

  test("a rejected request names the command but never the token", async () => {
    const token = `wrong-${randomUUID()}`;
    const store = storeWith(`${upstash.prefix}auth:`, token);

    const failure = store.position(randomUUID(), "a");

    await expect(failure).rejects.toThrow(/ZRANK/);
    await expect(failure).rejects.not.toThrow(token);
  });
});
