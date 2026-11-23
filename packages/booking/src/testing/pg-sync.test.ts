import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { block, latch, testClients, waitForPg, withTrigger } from "./index";

const database = setupTestDatabase();
const { db, open } = testClients(database);

/** Rows of `pg_class`, `pg_proc` and `pg_trigger` whose names start with `prefix`. */
async function objectsNamed(prefix: string): Promise<string[]> {
  const rows = await db().$queryRaw<{ name: string }[]>`
    SELECT relname::text AS name FROM pg_class WHERE relname LIKE ${`${prefix}%`}
    UNION ALL SELECT proname::text FROM pg_proc WHERE proname LIKE ${`${prefix}%`}
    UNION ALL SELECT tgname::text FROM pg_trigger WHERE tgname LIKE ${`${prefix}%`}`;
  return rows.map((row) => row.name).sort();
}

/** Collects unhandled rejections while `work` runs; Node reports them on the process. */
async function unhandledDuring(work: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    await work();
    // One more round trip: Node reports an unhandled rejection after the microtasks drain.
    await db().$queryRaw`SELECT 1`;
  } finally {
    process.off("unhandledRejection", record);
  }
  return unhandled;
}

describe("waitForPg", () => {
  test("fails at its deadline with a message naming what it waited for", async () => {
    const never = async () =>
      (await db().$queryRaw<{ one: number }[]>`SELECT 1 AS one WHERE false`)[0];

    await expect(waitForPg("a row that never appears", never, { deadlineMs: 200 })).rejects.toThrow(
      "waitForPg: no a row that never appears within 200 ms",
    );
  });

  test("returns what the probe found", async () => {
    const found = await waitForPg(
      "the backend's own pid",
      async () => (await db().$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0],
    );

    expect(found).toMatchObject({ pid: expect.any(Number) });
  });

  test("surfaces the rejection of the call it is raced against at once, and probes no more", async () => {
    const failure = new Error("the call under test failed");
    let fail: (error: Error) => void = () => undefined;
    const call = new Promise<never>((_, reject) => {
      fail = reject;
    });
    let probes = 0;
    let probesWhenTheCallFailed: number | undefined;

    const waiting = waitForPg(
      "a row that never appears",
      async () => {
        probes += 1;
        return (await db().$queryRaw<{ one: number }[]>`SELECT 1 AS one WHERE false`)[0];
      },
      {
        against: call,
        // The call fails while the wait pauses between probes: a loop that ignores it probes on.
        pause: async () => {
          probesWhenTheCallFailed = probes;
          fail(failure);
        },
      },
    );

    await expect(waiting).rejects.toBe(failure);
    // A loop that kept polling would have sent its next probe by the end of this round trip.
    await db().$queryRaw`SELECT 1`;
    expect(probesWhenTheCallFailed).toBe(1);
    expect(probes - (probesWhenTheCallFailed ?? 0)).toBe(0);
  });

  test("fails, naming what it waited for, when the call under test finishes first", async () => {
    await expect(
      waitForPg("a row that never appears", async () => undefined, {
        against: Promise.resolve("done"),
      }),
    ).rejects.toThrow("waitForPg: the call under test finished before a row that never appears");
  });
});

describe("block", () => {
  test("holds its lock until released, so another session queues behind it", async () => {
    const blocker = await block(db(), (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(4241)`, {
      what: "advisory lock 4241",
    });
    const [row] = await db().$queryRaw<{ state: string }[]>`
      SELECT state FROM pg_stat_activity WHERE pid = ${blocker.pid}::int`;

    expect(row?.state).toBe("idle in transaction");
    await blocker.release();
  });

  test("a blocker whose transaction fails while nothing awaits it reports the failure on release, never as an unhandled rejection", async () => {
    let released: Promise<void> | undefined;
    const unhandled = await unhandledDuring(async () => {
      const blocker = await block(db(), (tx) => tx.$queryRaw`SELECT 1`, {
        what: "a lock it holds too long",
        holdDeadlineMs: 100,
      });
      // The blocker gives up at its hold deadline while the test awaits only Postgres. Observed
      // from another client: the blocker's pool could hand its freed backend to the probe itself,
      // which would then only ever see itself active.
      const observer = open();
      await waitForPg("the blocker's transaction ended", async () => {
        const [row] = await observer.$queryRaw<{ state: string }[]>`
          SELECT state FROM pg_stat_activity WHERE pid = ${blocker.pid}::int`;
        return row === undefined || row.state === "idle" ? true : undefined;
      });
      released = blocker.release();
      await released.catch(() => undefined);
    });

    expect(unhandled).toEqual([]);
    await expect(released).rejects.toThrow(
      "block: held a lock it holds too long for 100 ms without a release",
    );
  });

  test("fails at its deadline, naming the lock it could not take", async () => {
    const holder = await block(db(), (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(4242)`, {
      what: "advisory lock 4242",
    });
    try {
      await expect(
        block(db(), (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(4242)`, {
          what: "advisory lock 4242",
          acquireDeadlineMs: 200,
        }),
      ).rejects.toThrow("block: advisory lock 4242 not taken within 200 ms");
    } finally {
      await holder.release();
    }
  });
});

describe("withTrigger", () => {
  test("removes its trigger, function, sequence and scratch table when the body throws", async () => {
    let prefix = "";
    const body = withTrigger(
      db(),
      {
        table: "seats",
        timing: "BEFORE UPDATE",
        when: "false",
        body: "INSERT INTO $scratch VALUES ($calls);",
        scratch: "calls bigint",
      },
      async (trigger) => {
        prefix = trigger.name;
        expect(await objectsNamed(prefix)).toHaveLength(4);
        throw new Error("the test failed");
      },
    );

    await expect(body).rejects.toThrow("the test failed");
    expect(prefix).not.toBe("");
    expect(await objectsNamed(prefix)).toEqual([]);
  });

  test("gives each trigger its own names", async () => {
    const spec = { table: "seats", timing: "BEFORE UPDATE", when: "false", body: "" };
    const names = await withTrigger(db(), spec, (first) =>
      withTrigger(db(), spec, async (second) => [first.name, second.name]),
    );

    expect(new Set(names).size).toBe(2);
  });
});

describe("latch", () => {
  test("opens once, for every waiter", async () => {
    const gate = latch();
    const waiters = Promise.all([gate.opened, gate.opened]);
    gate.open();
    gate.open();

    await expect(waiters).resolves.toEqual([undefined, undefined]);
  });
});
