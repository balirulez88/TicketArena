import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { QueueStore } from "./ports";

/** What the contract needs from an adapter's test file; test-only, not exported by the package. */
export interface QueueStoreContractHarness {
  /** A store whose keys all start with `prefix` (already unique to the test file). */
  store(prefix: string): QueueStore;
  /** `count` stores that do not share a connection, for races; `close` releases them. */
  independentStores(
    prefix: string,
    count: number,
  ): Promise<{ readonly stores: readonly QueueStore[]; close(): void }>;
}

/**
 * The `QueueStore` contract (ADR 0010, AT-42): every adapter runs these tests against its real
 * backend, so the waiting room behaves the same on Upstash in production as on Redis locally.
 */
export function describeQueueStoreContract(
  adapter: string,
  filePrefix: string,
  harness: QueueStoreContractHarness,
): void {
  const storeWith = (namespace: string) => harness.store(`${filePrefix}${namespace}`);

  describe(`QueueStore contract: ${adapter}`, () => {
    test("join returns the 1-based position and position reads it back", async () => {
      const store = storeWith("position:");
      const eventId = randomUUID();

      expect(await store.join(eventId, "a", { kind: "SEQUENCE" })).toBe(1);
      expect(await store.join(eventId, "b", { kind: "SEQUENCE" })).toBe(2);

      expect(await store.position(eventId, "b")).toBe(2);
      expect(await store.position(eventId, "nobody")).toBeNull();
    });

    test("pre-queue joins sort ahead of later joins by score; later joins are FIFO", async () => {
      const store = storeWith("order:");
      const eventId = randomUUID();

      await store.join(eventId, "early-high", { kind: "PRE_QUEUE", score: 0.9 });
      await store.join(eventId, "late-1", { kind: "SEQUENCE" });
      await store.join(eventId, "early-low", { kind: "PRE_QUEUE", score: 0.25 });
      await store.join(eventId, "late-2", { kind: "SEQUENCE" });

      expect(await store.position(eventId, "early-low")).toBe(1);
      expect(await store.position(eventId, "early-high")).toBe(2);
      expect(await store.position(eventId, "late-1")).toBe(3);
      expect(await store.position(eventId, "late-2")).toBe(4);
    });

    test("a second join keeps the first score (ZADD NX)", async () => {
      const store = storeWith("nx:");
      const eventId = randomUUID();
      await store.join(eventId, "a", { kind: "PRE_QUEUE", score: 0.9 });
      await store.join(eventId, "b", { kind: "PRE_QUEUE", score: 0.5 });

      expect(await store.join(eventId, "a", { kind: "PRE_QUEUE", score: 0.1 })).toBe(2);
      expect(await store.join(eventId, "a", { kind: "SEQUENCE" })).toBe(2);
    });

    test("leave removes the member and reports whether it was queued", async () => {
      const store = storeWith("leave:");
      const eventId = randomUUID();
      await store.join(eventId, "a", { kind: "SEQUENCE" });
      await store.join(eventId, "b", { kind: "SEQUENCE" });

      expect(await store.leave(eventId, "a")).toBe(true);
      expect(await store.leave(eventId, "a")).toBe(false);
      expect(await store.position(eventId, "a")).toBeNull();
      expect(await store.position(eventId, "b")).toBe(1);
    });

    test("stores with different prefixes do not share a queue", async () => {
      const eventId = randomUUID();
      await storeWith("one:").join(eventId, "a", { kind: "SEQUENCE" });

      expect(await storeWith("two:").position(eventId, "a")).toBeNull();
      expect(await storeWith("two:").join(eventId, "b", { kind: "SEQUENCE" })).toBe(1);
    });

    test("concurrent joins on separate connections get distinct consecutive positions", async () => {
      const eventId = randomUUID();
      const { stores, close } = await harness.independentStores(`${filePrefix}race:`, 8);
      try {
        const positions = await Promise.all(
          Array.from({ length: 40 }, (_, index) => {
            const store = stores[index % stores.length] ?? storeWith("race:");
            return store.join(eventId, `buyer-${index}`, { kind: "SEQUENCE" });
          }),
        );

        expect([...positions].sort((a, b) => a - b)).toEqual(
          Array.from({ length: 40 }, (_, index) => index + 1),
        );
      } finally {
        close();
      }
    });
  });
}
