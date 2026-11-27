import {
  BookingBusyError,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
  HoldSeatSetMissingError,
  IdempotencyKeyReusedError,
  InvalidSeatSelectionError,
  LimitExceededError,
  MixedCurrencyError,
  NotDemoEventError,
  NotOnSaleError,
  RefundNotInManualReviewError,
  RefundObligationNotFoundError,
  ResetBlockedError,
  SeatUnavailableError,
} from "@ticketarena/booking";
import type { TRPCError } from "@trpc/server";

/**
 * The domain errors the routers map to a `TRPCError` (always as its `cause`). An explicit list on
 * purpose: only these may name themselves to the client; any other cause, even one with a `code`
 * (a Prisma or Redis failure), is an internal detail and stays on the server.
 */
const DOMAIN_ERRORS = [
  SeatUnavailableError,
  LimitExceededError,
  BookingBusyError,
  InvalidSeatSelectionError,
  NotOnSaleError,
  HoldNotFoundError,
  HoldExpiredError,
  HoldNotActiveError,
  HoldSeatSetMissingError,
  MixedCurrencyError,
  IdempotencyKeyReusedError,
  ResetBlockedError,
  NotDemoEventError,
  RefundObligationNotFoundError,
  RefundNotInManualReviewError,
] as const;

type DomainError = InstanceType<(typeof DOMAIN_ERRORS)[number]>;

/** The code the client switches on; tRPC codes alone are shared by several refusals. */
export type DomainCode = DomainError["code"];

/** Both fields are absent for an error that is not a mapped domain error; `seatIds` is SEAT_UNAVAILABLE's. */
export interface DomainErrorData {
  readonly domainCode?: DomainCode;
  readonly seatIds?: readonly string[];
}

function isDomainError(cause: unknown): cause is DomainError {
  return DOMAIN_ERRORS.some((DomainErrorClass) => cause instanceof DomainErrorClass);
}

/**
 * What the error formatter adds to a refusal's `data`. A domain error that reaches tRPC unmapped
 * becomes an `INTERNAL_SERVER_ERROR` and gets nothing: the client only ever learns codes a router
 * deliberately chose to expose.
 */
export function domainErrorData(error: TRPCError): DomainErrorData {
  if (error.code === "INTERNAL_SERVER_ERROR" || !isDomainError(error.cause)) {
    return {};
  }
  if (error.cause instanceof SeatUnavailableError) {
    return { domainCode: error.cause.code, seatIds: [...error.cause.seatIds] };
  }
  return { domainCode: error.cause.code };
}
