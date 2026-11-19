import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { AdmitRequest, QueueStore } from "./ports";

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
  const queuedAt = (position: number) => ({ status: "QUEUED", position });
  const T0 = new Date("2027-05-01T10:00:00.000Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);

  describe(`QueueStore contract: ${adapter}`, () => {
    test("join returns the 1-based position and position reads it back", async () => {
      const store = storeWith("position:");
      const eventId = randomUUID();

      expect(await store.join(eventId, "a", { kind: "SEQUENCE" }, T0)).toEqual(queuedAt(1));
      expect(await store.join(eventId, "b", { kind: "SEQUENCE" }, T0)).toEqual(queuedAt(2));

      expect(await store.position(eventId, "b")).toBe(2);
      expect(await store.position(eventId, "nobody")).toBeNull();
    });

    test("pre-queue joins sort ahead of later joins by score; later joins are FIFO", async () => {
      const store = storeWith("order:");
      const eventId = randomUUID();

      await store.join(eventId, "early-high", { kind: "PRE_QUEUE", score: 0.9 }, T0);
      await store.join(eventId, "late-1", { kind: "SEQUENCE" }, T0);
      await store.join(eventId, "early-low", { kind: "PRE_QUEUE", score: 0.25 }, T0);
      await store.join(eventId, "late-2", { kind: "SEQUENCE" }, T0);

      expect(await store.position(eventId, "early-low")).toBe(1);
      expect(await store.position(eventId, "early-high")).toBe(2);
      expect(await store.position(eventId, "late-1")).toBe(3);
      expect(await store.position(eventId, "late-2")).toBe(4);
    });

    test("a second join keeps the first score (ZADD NX)", async () => {
      const store = storeWith("nx:");
      const eventId = randomUUID();
      await store.join(eventId, "a", { kind: "PRE_QUEUE", score: 0.9 }, T0);
      await store.join(eventId, "b", { kind: "PRE_QUEUE", score: 0.5 }, T0);

      expect(await store.join(eventId, "a", { kind: "PRE_QUEUE", score: 0.1 }, T0)).toEqual(
        queuedAt(2),
      );
      expect(await store.join(eventId, "a", { kind: "SEQUENCE" }, T0)).toEqual(queuedAt(2));
    });

    test("leave removes the member and reports whether it was queued", async () => {
      const store = storeWith("leave:");
      const eventId = randomUUID();
      await store.join(eventId, "a", { kind: "SEQUENCE" }, T0);
      await store.join(eventId, "b", { kind: "SEQUENCE" }, T0);

      expect(await store.leave(eventId, "a")).toBe(true);
      expect(await store.leave(eventId, "a")).toBe(false);
      expect(await store.position(eventId, "a")).toBeNull();
      expect(await store.position(eventId, "b")).toBe(1);
    });

    test("stores with different prefixes do not share a queue", async () => {
      const eventId = randomUUID();
      await storeWith("one:").join(eventId, "a", { kind: "SEQUENCE" }, T0);

      expect(await storeWith("two:").position(eventId, "a")).toBeNull();
      expect(await storeWith("two:").join(eventId, "b", { kind: "SEQUENCE" }, T0)).toEqual(
        queuedAt(1),
      );
    });

    test("concurrent joins on separate connections get distinct consecutive positions", async () => {
      const eventId = randomUUID();
      const { stores, close } = await harness.independentStores(`${filePrefix}race:`, 8);
      try {
        const positions = await Promise.all(
          Array.from({ length: 40 }, async (_, index) => {
            const store = stores[index % stores.length] ?? storeWith("race:");
            const joined = await store.join(eventId, `buyer-${index}`, { kind: "SEQUENCE" }, T0);
            return joined.status === "QUEUED" ? joined.position : 0;
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

  describe(`QueueStore contract (admission and slots): ${adapter}`, () => {
    const TTL = 30 * 60_000;
    const request = (
      now: Date,
      admitRate: number,
      maxActive: number,
      count = admitRate,
    ): AdmitRequest => ({
      now,
      admitRate,
      maxActive,
      admissionTtlMs: TTL,
      jtis: Array.from({ length: count }, () => randomUUID()),
    });

    async function queueOf(store: QueueStore, eventId: string, count: number) {
      for (let index = 1; index <= count; index += 1) {
        await store.join(eventId, `m${index}`, { kind: "SEQUENCE" }, T0);
      }
    }

    test("admit moves the queue head into the active set, in queue order, with one jti each", async () => {
      const store = storeWith("admit:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 3);

      const admitted = await store.admit(eventId, request(T0, 2, 10));

      expect(admitted.map((admission) => admission.sessionId)).toEqual(["m1", "m2"]);
      expect(new Set(admitted.map((admission) => admission.jti)).size).toBe(2);
      expect(await store.position(eventId, "m1")).toBeNull();
      expect(await store.position(eventId, "m3")).toBe(1);
      expect(await store.counts(eventId)).toEqual({ queued: 1, active: 2 });
      for (const admission of admitted) {
        expect(await store.isAdmitted(eventId, admission.jti, T0)).toBe(true);
      }
    });

    test("the token bucket starts full at admitRate and refills at admitRate per second", async () => {
      const store = storeWith("bucket:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 20);

      expect(await store.admit(eventId, request(T0, 4, 100))).toHaveLength(4);
      expect(await store.admit(eventId, request(T0, 4, 100))).toHaveLength(0);
      expect(await store.admit(eventId, request(at(500), 4, 100))).toHaveLength(2);
      // A long pause refills only up to the burst.
      expect(await store.admit(eventId, request(at(60_000), 4, 100))).toHaveLength(4);
    });

    test("admit never fills more than maxActive slots", async () => {
      const store = storeWith("cap:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 10);

      expect(await store.admit(eventId, request(T0, 5, 3))).toHaveLength(3);
      expect(await store.admit(eventId, request(at(5_000), 5, 3))).toHaveLength(0);
      await store.releaseSlot(eventId, "m1");
      expect(await store.admit(eventId, request(at(10_000), 5, 3))).toEqual([
        expect.objectContaining({ sessionId: "m4" }),
      ]);
      expect(await store.counts(eventId)).toEqual({ queued: 6, active: 3 });
    });

    test("an empty queue spends no tokens", async () => {
      const store = storeWith("empty:");
      const eventId = randomUUID();

      expect(await store.admit(eventId, request(T0, 3, 10))).toEqual([]);
      await queueOf(store, eventId, 5);
      expect(await store.admit(eventId, request(T0, 3, 10))).toHaveLength(3);
    });

    test("heartbeat refreshes only members that hold a slot", async () => {
      const store = storeWith("heartbeat:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 2);
      await store.admit(eventId, request(T0, 1, 10));

      expect(await store.heartbeat(eventId, "m1", at(60_000))).toBe(true);
      expect(await store.heartbeat(eventId, "m2", at(60_000))).toBe(false);
      expect(await store.heartbeat(eventId, "nobody", at(60_000))).toBe(false);
      expect(await store.counts(eventId)).toEqual({ queued: 1, active: 1 });
      // The heartbeat at 60s keeps m1 out of a reap that frees anything idle since 30s.
      expect(await store.reap(eventId, { now: at(120_000), idleBefore: at(30_000) })).toEqual([]);
    });

    test("releaseSlot frees the slot and revokes the admission jti", async () => {
      const store = storeWith("release:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 1);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));

      expect(await store.releaseSlot(eventId, "m1")).toBe(true);
      expect(await store.releaseSlot(eventId, "m1")).toBe(false);
      expect(await store.isAdmitted(eventId, admission?.jti ?? "", T0)).toBe(false);
      expect(await store.heartbeat(eventId, "m1", T0)).toBe(false);
      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 0 });
    });

    test("leave also frees the member's slot and revokes its jti", async () => {
      const store = storeWith("leave-slot:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 2);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));

      expect(await store.leave(eventId, "m1")).toBe(true);
      expect(await store.leave(eventId, "m1")).toBe(false);
      expect(await store.isAdmitted(eventId, admission?.jti ?? "", T0)).toBe(false);
      expect(await store.heartbeat(eventId, "m1", T0)).toBe(false);
      expect(await store.counts(eventId)).toEqual({ queued: 1, active: 0 });
      expect(await store.leave(eventId, "m2")).toBe(true);
    });

    test("a leave racing a ticker on another connection never leaves the member admitted", async () => {
      // Leaving is one script: whichever runs first, the member ends with no queue entry, no
      // slot and no valid jti. Two separate commands would let the ticker admit in between.
      const { stores, close } = await harness.independentStores(`${filePrefix}leave-race:`, 2);
      const [leaver, ticker] = stores;
      if (leaver === undefined || ticker === undefined) {
        throw new Error("independentStores returned fewer than two stores");
      }
      try {
        for (let round = 0; round < 25; round += 1) {
          const eventId = randomUUID();
          await leaver.join(eventId, "m", { kind: "SEQUENCE" }, T0);

          const [, admitted] = await Promise.all([
            leaver.leave(eventId, "m"),
            ticker.admit(eventId, request(T0, 1, 10)),
          ]);

          expect(await leaver.counts(eventId)).toEqual({ queued: 0, active: 0 });
          for (const admission of admitted) {
            expect(await leaver.isAdmitted(eventId, admission.jti, T0)).toBe(false);
          }
        }
      } finally {
        close();
      }
    });

    test("join by a member that holds a slot answers ADMITTED and keeps its jti and its one slot", async () => {
      const store = storeWith("rejoin-admitted:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 2);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));
      const jti = admission?.jti ?? "";

      expect(await store.join(eventId, "m1", { kind: "SEQUENCE" }, T0)).toEqual({
        status: "ADMITTED",
      });
      expect(await store.join(eventId, "m1", { kind: "PRE_QUEUE", score: 0.1 }, T0)).toEqual({
        status: "ADMITTED",
      });

      expect(await store.position(eventId, "m1")).toBeNull();
      expect(await store.counts(eventId)).toEqual({ queued: 1, active: 1 });
      // More ticks admit m2 and then find an empty queue: m1 is never re-admitted with a new jti.
      const later = [
        ...(await store.admit(eventId, request(at(1_000), 1, 10))),
        ...(await store.admit(eventId, request(at(2_000), 1, 10))),
      ];
      expect(later.map((next) => next.sessionId)).toEqual(["m2"]);
      expect(await store.isAdmitted(eventId, jti, at(2_000))).toBe(true);
      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 2 });
      expect(await store.releaseSlot(eventId, "m1")).toBe(true);
      expect(await store.releaseSlot(eventId, "m1")).toBe(false);
    });

    test("a member whose slot was freed (leave, release, reap) joins again at the back", async () => {
      const store = storeWith("rejoin-freed:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 4);
      await store.admit(eventId, request(T0, 3, 10));
      await store.leave(eventId, "m1");
      await store.releaseSlot(eventId, "m2");
      await store.heartbeat(eventId, "m3", at(TTL));
      expect(await store.reap(eventId, { now: at(TTL), idleBefore: at(TTL - 5_000) })).toEqual([
        "m3",
      ]);

      expect(await store.join(eventId, "m2", { kind: "SEQUENCE" }, T0)).toEqual(queuedAt(2));
      expect(await store.join(eventId, "m1", { kind: "SEQUENCE" }, T0)).toEqual(queuedAt(3));
      expect(await store.join(eventId, "m3", { kind: "SEQUENCE" }, T0)).toEqual(queuedAt(4));
      expect(await store.counts(eventId)).toEqual({ queued: 4, active: 0 });
    });

    test("a join racing a ticker on another connection never queues an admitted member again", async () => {
      // The slot check and the queue write are one script: whichever runs first, the member ends
      // admitted once and not queued. Separate commands would let the ticker admit in between.
      const { stores, close } = await harness.independentStores(`${filePrefix}join-race:`, 2);
      const [joiner, ticker] = stores;
      if (joiner === undefined || ticker === undefined) {
        throw new Error("independentStores returned fewer than two stores");
      }
      try {
        for (let round = 0; round < 25; round += 1) {
          const eventId = randomUUID();
          await joiner.join(eventId, "m", { kind: "SEQUENCE" }, T0);

          const [, admitted] = await Promise.all([
            joiner.join(eventId, "m", { kind: "SEQUENCE" }, T0),
            ticker.admit(eventId, request(T0, 1, 10)),
          ]);

          expect(admitted).toHaveLength(1);
          expect(await joiner.counts(eventId)).toEqual({ queued: 0, active: 1 });
          expect(await joiner.join(eventId, "m", { kind: "SEQUENCE" }, T0)).toEqual({
            status: "ADMITTED",
          });
        }
      } finally {
        close();
      }
    });

    test("join by a member whose admission expired frees its slot, revokes its jti and queues it at the back", async () => {
      const store = storeWith("rejoin-expired:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 2);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));
      // The reaper has not run: m1 still holds its slot, but its admission expired at TTL.
      expect(await store.join(eventId, "m1", { kind: "SEQUENCE" }, at(TTL))).toEqual(queuedAt(2));

      expect(await store.isAdmitted(eventId, admission?.jti ?? "", at(TTL - 1))).toBe(false);
      expect(await store.admission(eventId, "m1", at(TTL - 1))).toBeNull();
      expect(await store.counts(eventId)).toEqual({ queued: 2, active: 0 });
    });

    test("join leaves a slot alone until the instant its admission expires", async () => {
      const store = storeWith("rejoin-boundary:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 1);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));

      expect(await store.join(eventId, "m1", { kind: "SEQUENCE" }, at(TTL - 1))).toEqual({
        status: "ADMITTED",
      });
      expect(await store.isAdmitted(eventId, admission?.jti ?? "", at(TTL - 1))).toBe(true);
    });

    test("a delayed join after an expired slot was replaced keeps the fresh admission", async () => {
      // The interleaving from the PR #12 review: join A clears the expired slot and queues m, the
      // ticker admits m with a fresh jti, then join B (sent at the same time as A) arrives. B must
      // see the fresh admission and leave it alone, because the check and the removal are one step.
      const store = storeWith("rejoin-delayed:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 1);
      await store.admit(eventId, request(T0, 1, 10));

      expect(await store.join(eventId, "m1", { kind: "SEQUENCE" }, at(TTL))).toEqual(queuedAt(1));
      const [fresh] = await store.admit(eventId, request(at(TTL), 1, 10));
      expect(await store.join(eventId, "m1", { kind: "SEQUENCE" }, at(TTL))).toEqual({
        status: "ADMITTED",
      });

      expect(await store.isAdmitted(eventId, fresh?.jti ?? "", at(TTL))).toBe(true);
      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 1 });
    });

    test("concurrent rejoins of an expired slot racing a ticker never revoke a fresh admission", async () => {
      // Two rejoins (a refresh and a second tab) and a tick run on separate connections after m's
      // admission expired. Whatever the order, m ends either queued or holding the jti the ticker
      // granted, never both and never with that jti revoked; a later delayed join changes nothing.
      const { stores, close } = await harness.independentStores(`${filePrefix}rejoin-race:`, 3);
      const [first, second, ticker] = stores;
      if (first === undefined || second === undefined || ticker === undefined) {
        throw new Error("independentStores returned fewer than three stores");
      }
      const rejoinRound = async () => {
        const eventId = randomUUID();
        await first.join(eventId, "m", { kind: "SEQUENCE" }, T0);
        await ticker.admit(eventId, request(T0, 1, 10));

        const [, , admitted] = await Promise.all([
          first.join(eventId, "m", { kind: "SEQUENCE" }, at(TTL)),
          second.join(eventId, "m", { kind: "SEQUENCE" }, at(TTL)),
          ticker.admit(eventId, request(at(TTL), 1, 10)),
        ]);
        const delayed = await second.join(eventId, "m", { kind: "SEQUENCE" }, at(TTL));

        const counts = await first.counts(eventId);
        expect(counts.queued + counts.active).toBe(1);
        for (const admission of admitted) {
          expect(await first.isAdmitted(eventId, admission.jti, at(TTL))).toBe(true);
        }
        expect(delayed).toEqual(admitted.length === 1 ? { status: "ADMITTED" } : queuedAt(1));
      };
      try {
        for (let round = 0; round < 25; round += 1) {
          await rejoinRound();
        }
      } finally {
        close();
      }
    });

    test("reap frees idle slots and slots whose admission expired, revoking their jtis", async () => {
      const store = storeWith("reap:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 3);
      const first = await store.admit(eventId, request(T0, 1, 10));
      const later = await store.admit(eventId, request(at(TTL - 10_000), 2, 10));
      // m1 keeps heartbeating but its admission expires at TTL; m3 stays fresh; m2 goes idle.
      await store.heartbeat(eventId, "m1", at(TTL));
      await store.heartbeat(eventId, "m3", at(TTL));

      const freed = await store.reap(eventId, { now: at(TTL), idleBefore: at(TTL - 5_000) });

      expect([...freed].sort()).toEqual(["m1", "m2"]);
      const jtiOf = (member: string) =>
        [...first, ...later].find((admission) => admission.sessionId === member)?.jti ?? "";
      expect(await store.isAdmitted(eventId, jtiOf("m1"), at(TTL - 1))).toBe(false);
      expect(await store.isAdmitted(eventId, jtiOf("m2"), at(TTL))).toBe(false);
      expect(await store.isAdmitted(eventId, jtiOf("m3"), at(TTL))).toBe(true);
      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 1 });
    });

    test("clearEvent drops the event's queue, slots, admissions and bucket, and no other event's", async () => {
      const store = storeWith("clear:");
      const eventId = randomUUID();
      const otherId = randomUUID();
      await queueOf(store, eventId, 3);
      await queueOf(store, otherId, 2);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));
      await store.admit(otherId, request(T0, 1, 10));

      await store.clearEvent(eventId);

      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 0 });
      expect(await store.isAdmitted(eventId, admission?.jti ?? "", T0)).toBe(false);
      // The bucket starts full again and the sequence restarts, as for a never-seen event.
      await queueOf(store, eventId, 3);
      expect(await store.position(eventId, "m1")).toBe(1);
      expect(await store.admit(eventId, request(T0, 2, 10))).toHaveLength(2);
      expect(await store.counts(otherId)).toEqual({ queued: 1, active: 1 });
    });

    test("an admission is valid until its expiry", async () => {
      const store = storeWith("expiry:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 1);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));
      const jti = admission?.jti ?? "";

      expect(await store.isAdmitted(eventId, jti, at(TTL - 1))).toBe(true);
      expect(await store.isAdmitted(eventId, jti, at(TTL))).toBe(false);
      expect(await store.isAdmitted(eventId, "unknown", T0)).toBe(false);
    });

    test("admission reads back the member's jti and expiry; null without a slot", async () => {
      const store = storeWith("admission:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 2);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));

      expect(await store.admission(eventId, "m1", T0)).toEqual({
        jti: admission?.jti,
        expiresAt: at(TTL),
      });
      expect(await store.admission(eventId, "m2", T0)).toBeNull();
      expect(await store.admission(eventId, "nobody", T0)).toBeNull();
      await store.releaseSlot(eventId, "m1");
      expect(await store.admission(eventId, "m1", T0)).toBeNull();
    });

    test("admitImmediately gives the member a slot and a jti valid for the ttl, bypassing the queue", async () => {
      const store = storeWith("admit-now:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 2);
      const jti = randomUUID();

      expect(
        await store.admitImmediately(eventId, "m2", { now: T0, admissionTtlMs: TTL, jti }),
      ).toBe(true);

      expect(await store.admission(eventId, "m2", T0)).toEqual({ jti, expiresAt: at(TTL) });
      expect(await store.isAdmitted(eventId, jti, at(TTL - 1))).toBe(true);
      expect(await store.position(eventId, "m2")).toBeNull();
      expect(await store.counts(eventId)).toEqual({ queued: 1, active: 1 });
      expect(await store.heartbeat(eventId, "m2", T0)).toBe(true);
    });

    test("admitImmediately keeps a member's existing slot and jti", async () => {
      const store = storeWith("admit-now-again:");
      const eventId = randomUUID();
      const first = randomUUID();
      await store.admitImmediately(eventId, "m1", { now: T0, admissionTtlMs: TTL, jti: first });

      expect(
        await store.admitImmediately(eventId, "m1", {
          now: at(60_000),
          admissionTtlMs: TTL,
          jti: randomUUID(),
        }),
      ).toBe(false);

      expect(await store.admission(eventId, "m1", T0)).toEqual({ jti: first, expiresAt: at(TTL) });
      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 1 });
    });

    test("admission is null once its jti expired, before any reap", async () => {
      const store = storeWith("admission-expiry:");
      const eventId = randomUUID();
      await queueOf(store, eventId, 1);
      const [admission] = await store.admit(eventId, request(T0, 1, 10));

      expect(await store.admission(eventId, "m1", at(TTL - 1))).toEqual({
        jti: admission?.jti,
        expiresAt: at(TTL),
      });
      expect(await store.admission(eventId, "m1", at(TTL))).toBeNull();
    });

    test("admitImmediately replaces a slot whose admission expired with a fresh jti", async () => {
      const store = storeWith("admit-now-expired:");
      const eventId = randomUUID();
      const first = randomUUID();
      const second = randomUUID();
      await store.admitImmediately(eventId, "m1", { now: T0, admissionTtlMs: TTL, jti: first });

      expect(
        await store.admitImmediately(eventId, "m1", {
          now: at(TTL),
          admissionTtlMs: TTL,
          jti: second,
        }),
      ).toBe(true);

      expect(await store.admission(eventId, "m1", at(TTL))).toEqual({
        jti: second,
        expiresAt: at(2 * TTL),
      });
      expect(await store.isAdmitted(eventId, first, T0)).toBe(false);
      expect(await store.counts(eventId)).toEqual({ queued: 0, active: 1 });
    });

    test("AT-38: concurrent admit ticks on separate connections never exceed the bucket or maxActive", async () => {
      const eventId = randomUUID();
      await queueOf(storeWith("admit-race:"), eventId, 50);
      const { stores, close } = await harness.independentStores(`${filePrefix}admit-race:`, 8);
      try {
        const burst = await Promise.all(
          stores.map((store) => store.admit(eventId, request(T0, 5, 7))),
        );
        const refill = await Promise.all(
          stores.map((store) => store.admit(eventId, request(at(1_000), 5, 7))),
        );

        const first = burst.flat().map((admission) => admission.sessionId);
        const second = refill.flat().map((admission) => admission.sessionId);
        expect(first).toHaveLength(5);
        expect(second).toHaveLength(2);
        expect(new Set([...first, ...second]).size).toBe(7);
        expect(await storeWith("admit-race:").counts(eventId)).toEqual({ queued: 43, active: 7 });
      } finally {
        close();
      }
    });
  });
}
