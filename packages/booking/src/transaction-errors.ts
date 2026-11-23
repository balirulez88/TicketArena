/**
 * What a failed booking database call means:
 * - `retryable`: Postgres aborted the attempt for contention (`40P01`, `55P03`, `40001`); the
 *   whole transaction may run again because the failed attempt rolled back completely.
 * - `busy`: saturation the caller should retry later (`BOOKING_BUSY`).
 * - `internal`: anything else; it stays visible as an internal error.
 */
export type BookingErrorKind = "retryable" | "busy" | "internal";

/** deadlock_detected, lock_not_available (lock_timeout) and serialization_failure. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "55P03", "40001"]);

const QUERY_CANCELED = "57014";
/**
 * Postgres raises `57014` both for `statement_timeout` and for a cancel request from another
 * session; only its message tells them apart. Coupled to Postgres's wording, pinned by the
 * `57014` tests in `transaction-busy.test.ts` (and its counterpart, "canceling statement due to
 * user request"), so a reworded server message fails a test instead of changing behaviour.
 */
export const STATEMENT_TIMEOUT_MESSAGE = "canceling statement due to statement timeout";

/**
 * pg-pool's (and the Neon pool's) error when no pooled connection frees up within
 * `connectionTimeoutMillis`. It has no code, so the exact message is the only signal. Pinned by
 * the pool-acquire tests in `transaction-busy.test.ts` against the real driver. Opening a new
 * connection that times out is a different message ("Connection terminated due to connection
 * timeout"): a connection failure, not saturation.
 */
export const POOL_ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

const PRISMA_TRANSACTION_API_ERROR = "P2028";
/**
 * `P2028` covers every transaction API error: a start that waited past `maxWait` (saturation), but
 * also a transaction that outlived its own `timeout` or was already closed (the work may have
 * committed, so retrying it blindly is wrong). Only the start timeout is saturation, recognised
 * by Prisma's wording; pinned by the transaction-start tests in `transaction-busy.test.ts`.
 */
export const TRANSACTION_START_TIMEOUT_MESSAGE = "Unable to start a transaction in the given time";

/** A property of an error or of one of its nested objects; `undefined` for anything else. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The Postgres error behind a Prisma error. Both `@prisma/adapter-pg` and `@prisma/adapter-neon`
 * convert a server error into `DriverAdapterError` whose `cause` carries `originalCode` (the
 * SQLSTATE) and `originalMessage`; Prisma keeps it as `meta.driverAdapterError` whether the
 * statement was raw (`P2010`) or a model query (`P2034`, `P2039`, `P2002`, ...).
 */
function postgresCause(error: unknown): unknown {
  return field(field(field(error, "meta"), "driverAdapterError"), "cause");
}

export function classifyBookingError(error: unknown): BookingErrorKind {
  const postgres = postgresCause(error);
  const sqlState = field(postgres, "originalCode");
  if (typeof sqlState === "string") {
    if (RETRYABLE_SQLSTATES.has(sqlState)) {
      return "retryable";
    }
    // A statement that ran past statement_timeout is load; retrying it at once would add more.
    return sqlState === QUERY_CANCELED &&
      field(postgres, "originalMessage") === STATEMENT_TIMEOUT_MESSAGE
      ? "busy"
      : "internal";
  }
  const message = String(field(error, "message"));
  if (message === POOL_ACQUIRE_TIMEOUT_MESSAGE) {
    return "busy";
  }
  return field(error, "code") === PRISMA_TRANSACTION_API_ERROR &&
    message.includes(TRANSACTION_START_TIMEOUT_MESSAGE)
    ? "busy"
    : "internal";
}

/** The SQLSTATE of a retried attempt, for the log line. */
export function sqlStateOf(error: unknown): unknown {
  return field(postgresCause(error), "originalCode");
}
