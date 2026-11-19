"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckoutForm } from "@/components/checkout/checkout-form";
import { OrderStatus } from "@/components/checkout/order-status";
import type { SeatMapSeat } from "@/components/seat-map/seat-map";
import { MAX_SELECTED_SEATS, useSeatSelection } from "@/components/seat-map/seat-selection";
import type { AppRouter } from "@/server/routers/_app";
import { useTRPC } from "@/trpc/react";
import { type HoldFailure, holdFailure } from "./hold-failure";

type Hold = inferRouterOutputs<AppRouter>["booking"]["holdSeats"];

/** Why the last hold ended; `CHECKOUT_EXPIRED` is the server refusing the order with `HOLD_EXPIRED`. */
type Notice = "RELEASED" | "EXPIRED" | "CHECKOUT_EXPIRED";

const buttonClass =
  "w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50";

function seatName(seatId: string, seats: readonly SeatMapSeat[]): string {
  const seat = seats.find((candidate) => candidate.id === seatId);
  return seat === undefined
    ? "a seat no longer on the map"
    : `Section ${seat.section}, row ${seat.row}, seat ${seat.number}`;
}

function failureMessage(failure: HoldFailure, seats: readonly SeatMapSeat[]): string {
  switch (failure.kind) {
    case "SEAT_UNAVAILABLE":
      return `Some of your seats were just taken: ${failure.seatIds
        .map((seatId) => seatName(seatId, seats))
        .join("; ")}. Please choose other seats.`;
    case "LIMIT_EXCEEDED":
      return `You can have at most ${MAX_SELECTED_SEATS} seats for this event, counting seats you already hold or bought.`;
    case "BOOKING_BUSY":
      return "Booking is busy right now. Please try again in a moment.";
    case "FORBIDDEN":
      return "Your admission is no longer valid. Please join the queue again.";
    case "NOT_ON_SALE":
      return "Tickets for this event are not on sale yet.";
    case "OTHER":
      return "Your seats could not be held. Please try again.";
  }
}

/**
 * Time left until `expiresAt`, ticking every second. The deadline is the server's
 * `holdExpiresAt`, measured on the visitor's clock: a skewed clock shifts the display, but the
 * server alone decides when the hold expires.
 */
function useRemainingMs(expiresAt: Date): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, expiresAt.getTime() - now);
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ActiveHold({
  hold,
  seats,
  onReleased,
  onExpired,
  onPlaced,
  onCheckoutExpired,
}: {
  readonly hold: Hold;
  readonly seats: readonly SeatMapSeat[];
  readonly onReleased: () => void;
  readonly onExpired: () => void;
  readonly onPlaced: (orderId: string) => void;
  readonly onCheckoutExpired: () => void;
}) {
  const trpc = useTRPC();
  const release = useMutation(trpc.booking.releaseHold.mutationOptions({ onSuccess: onReleased }));
  const remainingMs = useRemainingMs(hold.holdExpiresAt);
  // An unresolved checkout may already have placed the order, so the deadline waits for the
  // checkout's answer instead of declaring the seats released (see CheckoutForm).
  const [checkoutUnresolved, setCheckoutUnresolved] = useState(false);

  useEffect(() => {
    if (remainingMs === 0 && !checkoutUnresolved) {
      onExpired();
    }
  }, [remainingMs, checkoutUnresolved, onExpired]);

  return (
    <section aria-label="Your hold" className="flex flex-col gap-3 rounded-xl border p-4">
      <h2 className="font-semibold text-xl">Your seats are held</h2>
      <ul className="text-sm">
        {hold.seatIds.map((seatId) => (
          <li key={seatId}>{seatName(seatId, seats)}</li>
        ))}
      </ul>
      <p>
        Time left:{" "}
        <span role="timer" className="font-mono">
          {formatRemaining(remainingMs)}
        </span>
      </p>
      <button
        type="button"
        className={buttonClass}
        disabled={release.isPending}
        onClick={() => release.mutate({ holdId: hold.id })}
      >
        Release seats
      </button>
      {release.isError ? (
        <p role="alert" className="text-destructive text-sm">
          The seats could not be released. Please try again.
        </p>
      ) : null}
      <CheckoutForm
        holdId={hold.id}
        holdExpired={remainingMs === 0}
        onPlaced={onPlaced}
        onHoldExpired={onCheckoutExpired}
        onUnresolvedChange={setCheckoutUnresolved}
      />
    </section>
  );
}

/**
 * Holding the selected seats for an admitted buyer, then the live hold: a countdown to the
 * server's `holdExpiresAt` and a release button. The hold lives in the `holdSeats` mutation's
 * result (server state), not in the selection store, which is emptied once its seats are held.
 * Mounted whether or not the session is admitted: the admission can lapse (30 min, fixed) while a
 * hold is still live, and the hold and a `FORBIDDEN` refusal must stay on screen when it does.
 * The live hold carries the checkout form; once the order is placed the order's status replaces
 * the hold, since `placeOrder` frees the admission slot and the hold no longer expires.
 */
export function HoldControls({
  eventId,
  seats,
  admitted,
}: {
  readonly eventId: string;
  readonly seats: readonly SeatMapSeat[];
  readonly admitted: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const selectedSeatIds = useSeatSelection((state) => state.selectedSeatIds);
  const clearSelection = useSeatSelection((state) => state.clear);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);

  const refreshSeats = useCallback(
    () => queryClient.invalidateQueries({ queryKey: trpc.seats.map.queryKey({ eventId }) }),
    [queryClient, trpc, eventId],
  );
  const hold = useMutation(
    trpc.booking.holdSeats.mutationOptions({
      onSuccess: () => {
        clearSelection();
        void refreshSeats();
      },
      onError: (error) => {
        void refreshSeats();
        if (error.data?.code === "FORBIDDEN") {
          // The admission is gone (expired or its slot was reaped); re-reading the status puts
          // the join button back.
          void queryClient.invalidateQueries({
            queryKey: trpc.queue.status.queryKey({ eventId }),
          });
        }
      },
    }),
  );
  const resetHold = hold.reset;
  const endHold = useCallback(
    (reason: Notice) => {
      resetHold();
      setNotice(reason);
      void refreshSeats();
    },
    [resetHold, refreshSeats],
  );
  const onReleased = useCallback(() => endHold("RELEASED"), [endHold]);
  const onExpired = useCallback(() => endHold("EXPIRED"), [endHold]);
  const onCheckoutExpired = useCallback(() => endHold("CHECKOUT_EXPIRED"), [endHold]);
  const onPlaced = useCallback(
    (placedOrderId: string) => {
      // The hold is now ORDERED: its countdown no longer applies, so the order takes its place.
      resetHold();
      setOrderId(placedOrderId);
      void refreshSeats();
    },
    [resetHold, refreshSeats],
  );

  if (orderId !== null) {
    return (
      <OrderStatus orderId={orderId}>
        <Link href={`/orders/${orderId}`} className="text-sm underline">
          Open the order status page
        </Link>
      </OrderStatus>
    );
  }
  if (hold.data !== undefined) {
    return (
      <ActiveHold
        hold={hold.data}
        seats={seats}
        onReleased={onReleased}
        onExpired={onExpired}
        onPlaced={onPlaced}
        onCheckoutExpired={onCheckoutExpired}
      />
    );
  }

  const count = selectedSeatIds.length;
  return (
    <div className="flex flex-col gap-2">
      {admitted ? (
        <button
          type="button"
          className={buttonClass}
          disabled={count === 0 || hold.isPending}
          onClick={() => {
            setNotice(null);
            hold.mutate({ eventId, seatIds: [...selectedSeatIds] });
          }}
        >
          Hold {count} {count === 1 ? "seat" : "seats"}
        </button>
      ) : null}
      {hold.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {failureMessage(holdFailure(hold.error), seats)}
        </p>
      ) : null}
      {notice === "RELEASED" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Seats released.
        </p>
      ) : null}
      {notice === "EXPIRED" ? (
        <p role="alert" className="text-destructive text-sm">
          Your hold expired and its seats were released. Please choose seats again.
        </p>
      ) : null}
      {notice === "CHECKOUT_EXPIRED" ? (
        <p role="alert" className="text-destructive text-sm">
          Your hold expired before your order was placed, and its seats were released. Please choose
          seats again.
        </p>
      ) : null}
    </div>
  );
}
