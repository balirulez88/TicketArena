"use client";

import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { ReactNode } from "react";
import { formatDateTime, formatPrice } from "@/lib/format";
import type { AppRouter } from "@/server/routers/_app";
import { useTRPC } from "@/trpc/react";

/** How often `booking.getOrder` is polled until the order reaches a final state (spec: 2 s). */
export const ORDER_POLL_MS = 2000;

type Order = inferRouterOutputs<AppRouter>["booking"]["getOrder"];
type OrderState = Order["status"];

/** `PENDING_PAYMENT` is the only state an order leaves; the other three never change again. */
function isFinal(status: OrderState | undefined): boolean {
  return status === "CONFIRMED" || status === "CANCELLED" || status === "EXPIRED";
}

/** A malformed id in the URL is as missing to a visitor as an unknown one. */
function isMissing(code: string | undefined): boolean {
  return code === "NOT_FOUND" || code === "BAD_REQUEST";
}

function Outcome({ order }: { readonly order: Order }) {
  switch (order.status) {
    case "PENDING_PAYMENT":
      return (
        <>
          Waiting for payment. It must arrive by{" "}
          <time dateTime={order.paymentDeadline.toISOString()}>
            {formatDateTime(order.paymentDeadline)}
          </time>
          ; this page updates on its own.
        </>
      );
    case "CONFIRMED":
      return (
        <>Your order is confirmed. A confirmation email is on its way to {order.contact.email}.</>
      );
    case "CANCELLED":
      return <>Your payment failed, so the order was cancelled and its seats were released.</>;
    case "EXPIRED":
      return (
        <>
          No payment arrived before the payment deadline, so the order expired and its seats were
          released.
        </>
      );
  }
}

/**
 * What the buyer can expect about refunds. `booking.getOrder` exposes no payment or refund data,
 * so this states the system's guarantee for the order's state (every charge that cannot be
 * applied to an order is refunded automatically, with an email when the refund starts and when it
 * completes) rather than the progress of a particular refund.
 */
function refundNote(status: OrderState): string | null {
  switch (status) {
    case "PENDING_PAYMENT":
      return null;
    case "CONFIRMED":
      return "If you were charged more than once for this order, the extra charge is refunded automatically. We email you when the refund starts and when it completes.";
    case "CANCELLED":
    case "EXPIRED":
      return "If you were charged for this order, the payment is refunded in full automatically. We email you when the refund starts and when it completes.";
  }
}

/**
 * An order followed until its outcome: `booking.getOrder` is polled every 2 s while the order is
 * `PENDING_PAYMENT` and not at all once it is final, since a final order never changes state.
 */
export function OrderStatus({
  orderId,
  children,
}: {
  readonly orderId: string;
  readonly children?: ReactNode;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.booking.getOrder.queryOptions(
      { orderId },
      {
        staleTime: 0,
        refetchInterval: (current) => {
          if (isMissing(current.state.error?.data?.code)) {
            return false;
          }
          return isFinal(current.state.data?.status) ? false : ORDER_POLL_MS;
        },
      },
    ),
  );

  // A failed poll keeps the last known order on screen; the next poll may succeed.
  const order = query.data;
  if (order === undefined) {
    if (query.isError) {
      return (
        <p role="alert" className="text-destructive">
          {isMissing(query.error.data?.code) ? "Order not found." : "Order could not be loaded."}
        </p>
      );
    }
    return <p className="text-muted-foreground">Loading order…</p>;
  }

  const tickets = order.lines.length;
  const refund = refundNote(order.status);
  return (
    <section aria-label="Order status" className="flex flex-col gap-3 rounded-xl border p-4">
      <h2 className="font-semibold text-xl">Your order</h2>
      <p role="status">
        <Outcome order={order} />
      </p>
      <p className="text-sm">
        {tickets} {tickets === 1 ? "ticket" : "tickets"}, total{" "}
        {formatPrice(order.totalMinor, order.currency)}
      </p>
      {refund === null ? null : (
        <p role="note" aria-label="Refunds" className="text-muted-foreground text-sm">
          {refund}
        </p>
      )}
      {children}
    </section>
  );
}
