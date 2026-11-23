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
const DEFAULT_WAIT_DEADLINE_MS = 10_000;

function pauseBetweenPolls(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_PAUSE_MS));
}

/** A promise that settles at `ms` with `value`, and a way to stop its timer. */
function timer<T>(ms: number, value: T): { readonly fired: Promise<T>; stop(): void } {
  let handle: NodeJS.Timeout | undefined;
  const fired = new Promise<T>((resolve) => {
    handle = setTimeout(resolve, ms, value);
  });
  return { fired, stop: () => clearTimeout(handle) };
}

export interface WaitOptions {
  /** Fails the wait with a message naming what it waited for once this has passed. */
  readonly deadlineMs?: number;
  /**
   * The call under test. If it settles first the wait stops polling at once: a rejection is
   * rethrown as it is, so an early failure is never mistaken for a slow one, and a result is an
   * error naming what the wait never saw.
   */
  readonly against?: Promise<unknown>;
  /** The pause between probes. Only a test of this helper replaces it. */
  readonly pause?: () => Promise<void>;
}

type Settled = { readonly resolved: unknown } | { readonly rejected: unknown };

/**
 * Polls a Postgres condition until `probe` returns a value. What the test waits for is decided by
 * Postgres state, never by elapsed time; the deadline only bounds a wait that would never end.
 */
export async function waitForPg<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { deadlineMs = DEFAULT_WAIT_DEADLINE_MS, against, pause = pauseBetweenPolls }: WaitOptions = {},
): Promise<T> {
  let settled: Settled | undefined;
  const settlement = (against ?? new Promise<never>(() => undefined)).then(
    (value) => {
      settled = { resolved: value };
    },
    (error: unknown) => {
      settled = { rejected: error };
    },
  );
  // Checked before every probe: once the call under test has settled, no further query is sent.
  const stopIfSettled = () => {
    if (settled === undefined) {
      return;
    }
    if ("rejected" in settled) {
      throw settled.rejected;
    }
    throw new Error(`waitForPg: the call under test finished before ${what}`, {
      cause: settled.resolved,
    });
  };
  const deadline = timer(deadlineMs, undefined);
  let expired = false;
  deadline.fired.then(() => {
    expired = true;
  });
  try {
    for (;;) {
      stopIfSettled();
      const probing = probe();
      // A probe abandoned below must not surface later as an unhandled rejection.
      probing.catch(() => undefined);
      const found = await Promise.race([probing, settlement, deadline.fired]);
      if (found !== undefined) {
        return found;
      }
      stopIfSettled();
      if (expired) {
        throw new Error(`waitForPg: no ${what} within ${deadlineMs} ms`);
      }
      await Promise.race([pause(), settlement, deadline.fired]);
    }
  } finally {
    deadline.stop();
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
    WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    ORDER BY query_start`;
  return rows;
}

/**
 * Waits until at least `count` backends are blocked by `blockerPid`, raced against the call under
 * test so a call that fails or finishes instead of blocking ends the wait at once.
 */
export function waitUntilBlocked(
  db: PrismaClient,
  blockerPid: number,
  { what, against, count = 1 }: { what: string; against: Promise<unknown>; count?: number },
): Promise<BlockedBackend[]> {
  return waitForPg(
    what,
    async () => {
      const blocked = await blockedBy(db, blockerPid);
      return blocked.length >= count ? blocked : undefined;
    },
    { against },
  );
}

/**
 * The call's outcome if it settles without ever waiting on a lock `blockerPid` holds, or
 * "blocked" as soon as Postgres shows it waiting there. A blocked call stays blocked until the
 * test releases the lock, so the poll cannot miss it.
 */
export async function settledUnlessBlocked<T>(
  db: PrismaClient,
  blockerPid: number,
  call: Promise<T>,
): Promise<PromiseSettledResult<T> | "blocked"> {
  let done = false;
  const outcome = Promise.allSettled([call]).then(([result]) => {
    done = true;
    if (result === undefined) {
      throw new Error("settledUnlessBlocked: allSettled returned nothing");
    }
    return result;
  });
  try {
    await waitUntilBlocked(db, blockerPid, {
      what: `a backend blocked by ${blockerPid}`,
      against: outcome,
    });
    return "blocked";
  } catch (error) {
    if (done) {
      return outcome;
    }
    throw error;
  }
}

/** The buyer advisory lock, keyed as the booking transaction keys it (ADR 0005). */
export function buyerLock(eventId: string, buyerKey: string) {
  return (tx: Pick<PrismaClient, "$executeRaw">) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${buyerKey}`}, 0))`;
}

/** Row locks on `ids` of `table`, taken `FOR UPDATE` in id order. */
export function rowLock(table: "seats" | "holds" | "orders", ids: readonly string[]) {
  return (tx: Pick<PrismaClient, "$queryRawUnsafe">) =>
    tx.$queryRawUnsafe(
      `SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [...ids],
    );
}

export interface Blocker {
  /** The backend holding the lock. */
  readonly pid: number;
  /**
   * Opens the blocker's latch; resolves once its transaction has committed. Rejects with the
   * transaction's failure, whenever it happened, including while nothing awaited the blocker.
   */
  release(): Promise<void>;
}

export interface BlockOptions {
  /** Names the lock in every failure message. */
  readonly what?: string;
  /** Runs in the same transaction once the latch opens (e.g. to close a deadlock cycle). */
  readonly afterRelease?: (tx: TransactionClient) => Promise<unknown>;
  /** Upper bound on taking the lock; past it the attempt is cancelled and `block` fails. */
  readonly acquireDeadlineMs?: number;
  /**
   * Upper bound on holding the lock without a release: a test that never releases it fails here
   * instead of leaving a transaction open. Never a way to time the release.
   */
  readonly holdDeadlineMs?: number;
}

const DEFAULT_ACQUIRE_DEADLINE_MS = 10_000;
const DEFAULT_HOLD_DEADLINE_MS = 60_000;

/**
 * Opens a blocker session: takes a lock in its own transaction and keeps it until `release()`,
 * never for a fixed time. The transaction's outcome is observed from the start, so a failure
 * while the test awaits something else is reported by `release()` instead of being an unhandled
 * rejection.
 */
export async function block(
  db: PrismaClient,
  lock: (tx: TransactionClient) => Promise<unknown>,
  {
    what = "its lock",
    afterRelease,
    acquireDeadlineMs = DEFAULT_ACQUIRE_DEADLINE_MS,
    holdDeadlineMs = DEFAULT_HOLD_DEADLINE_MS,
  }: BlockOptions = {},
): Promise<Blocker> {
  const gate = latch();
  let started: (pid: number) => void = () => undefined;
  const backend = new Promise<number>((resolve) => {
    started = resolve;
  });
  let locked: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let stopHolding: () => void = () => undefined;

  const transaction = db.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (row === undefined) {
        throw new Error("block: pg_backend_pid() returned no row");
      }
      started(row.pid);
      await lock(tx);
      const holding = timer(holdDeadlineMs, "expired" as const);
      stopHolding = holding.stop;
      locked();
      const ended = await Promise.race([gate.opened, holding.fired]);
      holding.stop();
      if (ended === "expired") {
        throw new Error(`block: held ${what} for ${holdDeadlineMs} ms without a release`);
      }
      await afterRelease?.(tx);
    },
    { maxWait: acquireDeadlineMs, timeout: holdDeadlineMs + acquireDeadlineMs },
  );
  // Observed at once and for good: the failure is kept for release(), never left unhandled.
  let failure: { readonly error: unknown } | undefined;
  const ended = transaction.then(
    () => undefined,
    (error: unknown) => {
      failure = { error };
    },
  );
  const release = async () => {
    gate.open();
    stopHolding();
    await ended;
    if (failure !== undefined) {
      throw failure.error;
    }
  };

  const acquiring = timer(acquireDeadlineMs, "expired" as const);
  try {
    const first = await Promise.race([held, ended.then(() => "ended" as const), acquiring.fired]);
    if (first === "ended") {
      throw new Error(`block: the blocker's transaction ended before it held ${what}`, {
        cause: failure?.error,
      });
    }
    if (first === "expired") {
      // Cancel the waiting lock statement, so no transaction outlives the failed setup.
      const pid = await Promise.race([backend, ended.then(() => undefined)]);
      if (pid !== undefined) {
        await db.$queryRaw`SELECT pg_cancel_backend(${pid}::int)`;
      }
      gate.open();
      await ended;
      throw new Error(`block: ${what} not taken within ${acquireDeadlineMs} ms`, {
        cause: failure?.error,
      });
    }
  } finally {
    acquiring.stop();
  }
  return { pid: await backend, release };
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

export interface TriggerSpec {
  readonly table: string;
  /** E.g. `BEFORE INSERT`, `AFTER UPDATE`. */
  readonly timing: string;
  /** Limits the trigger to the test's own rows. */
  readonly when: string;
  /**
   * PL/pgSQL run for each matching row. `$calls` is the call number from the trigger's own
   * sequence, which a rollback does not undo, so it counts attempts; `$scratch` is the scratch
   * table's name.
   */
  readonly body: string;
  /** Column list of a scratch table the body may write to, e.g. `lock text, statement text`. */
  readonly scratch?: string;
}

export interface TestTrigger {
  /** The prefix every object of this trigger is named with. */
  readonly name: string;
  /** The scratch table, when the spec asked for one. */
  readonly scratch: string;
  /** Calls of the trigger so far, rolled-back ones included. */
  calls(): Promise<number>;
}

/**
 * Installs a row trigger with test-unique names for the duration of `body`, and removes it, its
 * function, its sequence and its scratch table afterwards, also when `body` throws.
 */
export async function withTrigger<T>(
  db: PrismaClient,
  spec: TriggerSpec,
  body: (trigger: TestTrigger) => Promise<T>,
): Promise<T> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  const sequence = `${name}_calls`;
  const scratch = `${name}_scratch`;
  try {
    await db.$executeRawUnsafe(`CREATE SEQUENCE ${sequence}`);
    if (spec.scratch !== undefined) {
      await db.$executeRawUnsafe(`CREATE TABLE ${scratch} (${spec.scratch})`);
    }
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE calls bigint;
       BEGIN
         calls := nextval('${sequence}');
         ${spec.body.replaceAll("$calls", "calls").replaceAll("$scratch", scratch)}
         RETURN NEW;
       END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} ${spec.timing} ON ${spec.table} FOR EACH ROW WHEN (${spec.when}) EXECUTE FUNCTION ${name}_fn()`,
    );
    return await body({
      name,
      scratch,
      async calls() {
        const [row] = await db.$queryRawUnsafe<{ calls: bigint; called: boolean }[]>(
          `SELECT last_value AS calls, is_called AS called FROM ${sequence}`,
        );
        return row?.called === true ? Number(row.calls) : 0;
      },
    });
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${spec.table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}_fn()`);
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${scratch}`);
    await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${sequence}`);
  }
}
