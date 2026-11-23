/**
 * Timeouts of one booking transaction (ADR 0005). One value drives both the `SET LOCAL` values the
 * service applies and the Prisma transaction options the client is built with, so the two can
 * never disagree.
 */
export interface BookingTimeouts {
  /** `lock_timeout` of each attempt: a wait on one lock gives up with `55P03` after this. */
  readonly lockTimeoutMs: number;
  /** `statement_timeout` of each attempt: a statement is cancelled with `57014` after this. */
  readonly statementTimeoutMs: number;
  /** Re-runs after the first attempt for `40P01`, `55P03` and `40001`; then `BOOKING_BUSY`. */
  readonly retries: number;
}

export const DEFAULT_BOOKING_TIMEOUTS: BookingTimeouts = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  retries: 3,
};

/**
 * How long a caller waits for a pooled connection (`connectionTimeoutMillis`, both drivers) and,
 * as Prisma `maxWait`, for its transaction to start. Equal on purpose: a transaction waits for a
 * connection no longer than any other read, and either timeout means saturation. It also bounds
 * opening a new connection, so it leaves room for a cold Neon compute to answer.
 */
export const BOOKING_ACQUIRE_TIMEOUT_MS = 3_000;

/** placeOrder, the longest path, waits on the buyer advisory lock, the hold row and the seat rows. */
export const LOCK_WAITS_ON_LONGEST_PATH = 3;

/** Room for the round trips and the commit that are no lock wait and no single long statement. */
export const TRANSACTION_MARGIN_MS = 1_000;

/** A retry waits a uniformly random delay in [MIN, MAX) so colliding buyers fall out of step. */
export const RETRY_JITTER_MIN_MS = 20;
export const RETRY_JITTER_MAX_MS = 200;

/**
 * Prisma options for a client that runs booking transactions. The runtime `timeout` must outlast
 * an attempt that waits its full lock budget, or Prisma would expire a healthy transaction with
 * `P2028` before Postgres reports the real outcome.
 */
export function bookingTransactionOptions(timeouts: BookingTimeouts): {
  readonly maxWaitMs: number;
  readonly timeoutMs: number;
} {
  return {
    maxWaitMs: BOOKING_ACQUIRE_TIMEOUT_MS,
    timeoutMs:
      LOCK_WAITS_ON_LONGEST_PATH * timeouts.lockTimeoutMs +
      timeouts.statementTimeoutMs +
      TRANSACTION_MARGIN_MS,
  };
}

/** The delay before a retry for a random draw in [0, 1). */
export function retryDelayMs(random: number): number {
  return RETRY_JITTER_MIN_MS + Math.floor(random * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS));
}

/**
 * The longest a booking transaction can take from its first attempt to `BOOKING_BUSY`: every
 * attempt may wait `maxWait` to start and then run up to its transaction timeout, and every retry
 * first waits at most the maximum jitter.
 */
export function worstCaseBookingBusyMs(
  timeouts: BookingTimeouts = DEFAULT_BOOKING_TIMEOUTS,
  {
    maxWaitMs = bookingTransactionOptions(timeouts).maxWaitMs,
    maxJitterMs = RETRY_JITTER_MAX_MS,
  }: { readonly maxWaitMs?: number; readonly maxJitterMs?: number } = {},
): number {
  const attempts = timeouts.retries + 1;
  const perAttempt = maxWaitMs + bookingTransactionOptions(timeouts).timeoutMs;
  return attempts * perAttempt + timeouts.retries * maxJitterMs;
}
