import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "@/server/routers/_app";

export type HoldFailure =
  | { readonly kind: "SEAT_UNAVAILABLE"; readonly seatIds: readonly string[] }
  | { readonly kind: "LIMIT_EXCEEDED" }
  | { readonly kind: "BOOKING_BUSY" }
  | { readonly kind: "FORBIDDEN" }
  | { readonly kind: "NOT_ON_SALE" }
  | { readonly kind: "OTHER" };

/**
 * Names a `booking.holdSeats` refusal from the error's structured `data` only, never its message:
 * the server's error formatter adds the booking `domainCode` (and `SEAT_UNAVAILABLE`'s taken
 * `seatIds`), because `SEAT_UNAVAILABLE` and `LIMIT_EXCEEDED` share tRPC `CONFLICT`. A missing
 * admission is not a domain error and is recognised by tRPC `FORBIDDEN`.
 */
export function holdFailure(error: TRPCClientErrorLike<AppRouter>): HoldFailure {
  switch (error.data?.domainCode) {
    case "SEAT_UNAVAILABLE":
      return { kind: "SEAT_UNAVAILABLE", seatIds: error.data.seatIds ?? [] };
    case "LIMIT_EXCEEDED":
      return { kind: "LIMIT_EXCEEDED" };
    case "BOOKING_BUSY":
      return { kind: "BOOKING_BUSY" };
    case "NOT_ON_SALE":
      return { kind: "NOT_ON_SALE" };
    default:
      return error.data?.code === "FORBIDDEN" ? { kind: "FORBIDDEN" } : { kind: "OTHER" };
  }
}
