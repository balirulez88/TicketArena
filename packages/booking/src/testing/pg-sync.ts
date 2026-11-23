import { randomBytes } from "node:crypto";
import type { PrismaClient, TransactionClient } from "@ticketarena/db";

/** A one-shot gate a test opens; nothing in these helpers waits on wall-clock time instead. */
export interface Latch {
  readonly opened: Promise<void>;
  open(): void;
}

export function latch(): Latch {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const POLL_PAUSE_MS = 10;

export interface WaitOptions {
  /** Fails the wait with a message naming `what` once this has passed. */
  readonly deadlineMs?: number;
  /**
   * The call under test. If it settles first, the wait fails at once with its outcome instead of
   * running into the deadline, so an early failure is never mistaken for a slow one.
   */
  readonly against?: Promise<unknown>;
}

/** Polls `probe` until it returns a value, bounded by a deadline whose message names `what`. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { deadlineMs = 10_000, against }: WaitOptions = {},
): Promise<Awaited<T>> {
  let outcome: { readonly settledWith: unknown } | undefined;
  const settled = (against ?? new Promise<never>(() => undefined)).then(
    (value) => {
      outcome = { settledWith: { resolved: value } };
      return undefined;
    },
    (error: unknown) => {
      outcome = { settledWith: { rejected: error } };
      return undefined;
    },
  );
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = await Promise.race([probe(), settled]);
    if (found !== undefined) {
      return found;
    }
    if (outcome !== undefined) {
      throw new Error(`waitFor: the call under test settled before ${what}`, {
        cause: outcome.settledWith,
      });
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: no ${what} within ${deadlineMs} ms`);
    }
    // Spaces out polls only; what the test waits for is decided by Postgres state.
    await new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
  }
}

export interface BlockedBackend {
  readonly pid: number;
  /** `clock_timestamp() - query_start` of the blocked statement, as Postgres measures it. */
  readonly waitedMs: number;
}

/** Backends of the current database whose current statement waits on a lock `blockerPid` holds. */
export async function blockedBy(db: PrismaClient, blockerPid: number): Promise<BlockedBackend[]> {
  const rows = await db.$queryRaw<{ pid: number; waitedMs: number }[]>`
    SELECT pid,
           (EXTRACT(EPOCH FROM clock_timestamp() - query_start) * 1000)::float8 AS "waitedMs"
    FROM pg_stat_activity
    WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
  return rows;
}

export interface Blocker {
  /** The backend holding the lock. */
  readonly pid: number;
  /** Opens the blocker's latch; resolves once its transaction has ended. */
  release(): Promise<void>;
}

const BLOCKER_TIMEOUT_MS = 60_000;

/**
 * Takes a lock in its own transaction and keeps it until `release()`; never for a fixed time.
 * `afterRelease` runs in the same transaction once the latch opens (e.g. to close a deadlock
 * cycle); its failure rejects `release()`.
 */
export async function block(
  db: PrismaClient,
  lock: (tx: TransactionClient) => Promise<unknown>,
  afterRelease?: (tx: TransactionClient) => Promise<unknown>,
): Promise<Blocker> {
  const gate = latch();
  let signal: (pid: number) => void = () => undefined;
  const locked = new Promise<number>((resolve) => {
    signal = resolve;
  });
  const finished = db.$transaction(
    async (tx) => {
      await lock(tx);
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      signal(row?.pid ?? -1);
      await gate.opened;
      await afterRelease?.(tx);
    },
    { maxWait: 10_000, timeout: BLOCKER_TIMEOUT_MS },
  );
  const pid = await Promise.race([locked, finished.then(() => -1)]);
  if (pid < 0) {
    throw new Error("block: the blocker's transaction ended before it held its lock");
  }
  return {
    pid,
    release: () => {
      gate.open();
      return finished;
    },
  };
}

/**
 * The SQLSTATE and message Postgres raised, found along the error's `cause` chain where the
 * Prisma driver adapters put them (`meta.driverAdapterError.cause.originalCode`). Written apart
 * from the service's classifier so tests do not check that classifier against itself.
 */
export function postgresErrorOf(
  error: unknown,
): { readonly code: string; readonly message: string } | undefined {
  for (let current = error; current !== undefined; current = property(current, "cause")) {
    const cause = property(property(property(current, "meta"), "driverAdapterError"), "cause");
    const code = property(cause, "originalCode");
    if (typeof code === "string") {
      return { code, message: String(property(cause, "originalMessage") ?? "") };
    }
  }
  return undefined;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function sqlStateOf(error: unknown): string | undefined {
  return postgresErrorOf(error)?.code;
}

export interface TestTrigger {
  /** Calls of the trigger so far, from a sequence: rollbacks do not undo it. */
  calls(): Promise<number>;
  /** Drops the trigger, its function and its sequence. */
  remove(): Promise<void>;
}

/**
 * Installs a test-scoped row trigger with test-unique names. `body` is PL/pgSQL run for each
 * matching row; `$calls` in it is replaced by `nextval` of the trigger's own sequence, which
 * survives a rollback and so counts attempts. `when` limits it to the test's own rows.
 */
export async function testTrigger(
  db: PrismaClient,
  { table, timing, when, body }: { table: string; timing: string; when: string; body: string },
): Promise<TestTrigger> {
  const id = `t_${randomBytes(6).toString("hex")}`;
  const sequence = `${id}_calls`;
  await db.$executeRawUnsafe(`CREATE SEQUENCE ${sequence}`);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${id}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
     DECLARE calls bigint;
     BEGIN
       calls := nextval('${sequence}');
       ${body.replaceAll("$calls", "calls")}
       RETURN NEW;
     END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${id} ${timing} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${id}_fn()`,
  );
  return {
    async calls() {
      const [row] = await db.$queryRawUnsafe<{ calls: bigint; called: boolean }[]>(
        `SELECT last_value AS calls, is_called AS called FROM ${sequence}`,
      );
      return row?.called === true ? Number(row.calls) : 0;
    },
    async remove() {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${id} ON ${table}`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${id}_fn()`);
      await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${sequence}`);
    },
  };
}
