import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterEach, describe, expect, test } from "vitest";
import { occupy } from "./index";

const database = setupTestDatabase();
const opened: PrismaClient[] = [];

function client(pool: { poolMax?: number; acquireTimeoutMs?: number } = {}): PrismaClient {
  const created = createPrismaClient({ connectionString: database.url, driver: "pg", ...pool });
  opened.push(created);
  return created;
}

function tightPool(): PrismaClient {
  return client({ poolMax: 1, acquireTimeoutMs: 100 });
}

async function backendState(pid: number): Promise<string | undefined> {
  const rows = await client().$queryRaw<{ state: string }[]>`
    SELECT state FROM pg_stat_activity WHERE pid = ${pid}::int`;
  return rows[0]?.state;
}

// Longer than the 50 ms the saturation tests used to sleep: a caller that does not wait for the
// signal runs ahead of the occupier.
const slowStart = () => new Promise<void>((resolve) => setTimeout(resolve, 150));

afterEach(async () => {
  await Promise.all(opened.splice(0).map((created) => created.$disconnect()));
});

describe("occupy", () => {
  test("resolves only when Postgres shows its backend inside an open transaction", async () => {
    const occupation = await occupy(tightPool());

    expect(await backendState(occupation.backendPid)).toBe("idle in transaction");

    await occupation.release();
    expect(await backendState(occupation.backendPid)).toBe("idle");
  });

  test("waits for an occupier that is slow to start", async () => {
    const occupation = await occupy(tightPool(), { beforeStart: slowStart });

    expect(await backendState(occupation.backendPid)).toBe("idle in transaction");

    await occupation.release();
  });

  test("leaves a one-connection pool with nothing to give until it is released", async () => {
    const tight = tightPool();
    const occupation = await occupy(tight);

    await expect(tight.$queryRaw`SELECT 1`).rejects.toThrow(
      "timeout exceeded when trying to connect",
    );

    await occupation.release();
    expect(await tight.$queryRaw`SELECT 1 AS one`).toEqual([{ one: 1 }]);
  });

  test("starts again when the transaction could not start, as on a cold pool under load", async () => {
    const tight = tightPool();
    const first = await occupy(tight);
    const failures: unknown[] = [];
    let released: Promise<void> | undefined;

    const second = await occupy(tight, {
      onStartFailure: (error) => {
        failures.push(error);
        released ??= first.release();
      },
    });
    await released;

    expect(failures.length).toBeGreaterThan(0);
    expect(await backendState(second.backendPid)).toBe("idle in transaction");
    await second.release();
  });

  test("fails at its deadline, naming what it waited for", async () => {
    // No acquire timeout: only occupy's own deadline can end this wait.
    const tight = client({ poolMax: 1 });
    const first = await occupy(tight);

    await expect(occupy(tight, { deadlineMs: 300 })).rejects.toThrow(
      "occupy: did not hold a connection within 300 ms",
    );

    await first.release();
  });
});
