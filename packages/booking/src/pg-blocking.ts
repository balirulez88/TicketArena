import type { PrismaClient } from "@ticketarena/db";

/** Test helpers that synchronise on Postgres itself instead of sleeping. */

export async function backendPid(tx: Pick<PrismaClient, "$queryRaw">): Promise<number> {
  const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return row?.pid ?? 0;
}

/** Resolves once some other backend is waiting on a lock held by `blockerPid`. */
export async function waitUntilBlockedBy(
  observer: Pick<PrismaClient, "$queryRaw">,
  blockerPid: number,
): Promise<void> {
  for (;;) {
    const [row] = await observer.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
    if (Number(row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether the backend still has a transaction open (it holds its locks until it ends). */
export async function inTransaction(
  observer: Pick<PrismaClient, "$queryRaw">,
  pid: number,
): Promise<boolean> {
  const [row] = await observer.$queryRaw<{ open: boolean }[]>`
    SELECT (xact_start IS NOT NULL) AS open FROM pg_stat_activity WHERE pid = ${pid}::int`;
  return row?.open ?? false;
}

export interface Latch {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

export function latch(): Latch {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
