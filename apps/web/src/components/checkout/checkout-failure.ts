import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "@/server/routers/_app";

export type CheckoutFailure = "HOLD_EXPIRED" | "IDEMPOTENCY_KEY_REUSED" | "OTHER";

/**
 * Names a `booking.placeOrder` refusal (`booking.releaseHold` reuses it for `HOLD_EXPIRED`) from
 * the `domainCode` the server's error formatter adds, never from the message. Any other refusal,
 * and a network failure (no `data` at all), is `OTHER`.
 */
export function checkoutFailure(error: TRPCClientErrorLike<AppRouter>): CheckoutFailure {
  switch (error.data?.domainCode) {
    case "HOLD_EXPIRED":
      return "HOLD_EXPIRED";
    case "IDEMPOTENCY_KEY_REUSED":
      return "IDEMPOTENCY_KEY_REUSED";
    default:
      return "OTHER";
  }
}
