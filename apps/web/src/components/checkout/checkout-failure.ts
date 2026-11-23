import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "@/server/routers/_app";

export type CheckoutFailure = "HOLD_EXPIRED" | "IDEMPOTENCY_KEY_REUSED" | "OTHER";

/**
 * Names a `booking.placeOrder` refusal (`booking.releaseHold` reuses it for `HOLD_EXPIRED`).
 * `HOLD_EXPIRED` arrives as tRPC `PRECONDITION_FAILED`;
 * `IDEMPOTENCY_KEY_REUSED` shares `CONFLICT` with other refusals, so it is recognised by the
 * domain code its message starts with. A network failure has no `data` and is `OTHER`.
 */
export function checkoutFailure(error: TRPCClientErrorLike<AppRouter>): CheckoutFailure {
  if (error.data?.code === "PRECONDITION_FAILED" && error.message.startsWith("HOLD_EXPIRED:")) {
    return "HOLD_EXPIRED";
  }
  if (error.data?.code === "CONFLICT" && error.message.startsWith("IDEMPOTENCY_KEY_REUSED:")) {
    return "IDEMPOTENCY_KEY_REUSED";
  }
  return "OTHER";
}
