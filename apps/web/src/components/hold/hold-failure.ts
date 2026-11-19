import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "@/server/routers/_app";

export type HoldFailure =
  | { readonly kind: "SEAT_UNAVAILABLE"; readonly seatIds: readonly string[] }
  | { readonly kind: "LIMIT_EXCEEDED" }
  | { readonly kind: "BOOKING_BUSY" }
  | { readonly kind: "FORBIDDEN" }
  | { readonly kind: "NOT_ON_SALE" }
  | { readonly kind: "OTHER" };

const SEAT_UNAVAILABLE_PREFIX = "SEAT_UNAVAILABLE:";

/**
 * Names a `booking.holdSeats` refusal. The router maps both `SEAT_UNAVAILABLE` and
 * `LIMIT_EXCEEDED` to tRPC `CONFLICT`, so those two are told apart by the domain code each booking
 * error starts its message with; `SEAT_UNAVAILABLE`'s message then lists the taken seat ids.
 */
export function holdFailure(error: TRPCClientErrorLike<AppRouter>): HoldFailure {
  switch (error.data?.code) {
    case "CONFLICT":
      if (error.message.startsWith(SEAT_UNAVAILABLE_PREFIX)) {
        const seatIds = error.message
          .slice(SEAT_UNAVAILABLE_PREFIX.length)
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        return { kind: "SEAT_UNAVAILABLE", seatIds };
      }
      return error.message.startsWith("LIMIT_EXCEEDED:")
        ? { kind: "LIMIT_EXCEEDED" }
        : { kind: "OTHER" };
    case "TOO_MANY_REQUESTS":
      return { kind: "BOOKING_BUSY" };
    case "FORBIDDEN":
      return { kind: "FORBIDDEN" };
    case "PRECONDITION_FAILED":
      return { kind: "NOT_ON_SALE" };
    default:
      return { kind: "OTHER" };
  }
}
