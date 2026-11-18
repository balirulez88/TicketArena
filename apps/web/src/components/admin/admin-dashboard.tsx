"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminSnapshot, RaceResult, ResetDemoResult } from "@/server/routers/admin";
import { useTRPC } from "@/trpc/react";

/** The spec's refresh rate for the live snapshot. */
export const SNAPSHOT_POLL_MS = 1000;

const ORDER_STATUSES = [
  ["PENDING_PAYMENT", "Pending payment"],
  ["CONFIRMED", "Confirmed"],
  ["CANCELLED", "Cancelled"],
  ["EXPIRED", "Expired"],
] as const;

const SEAT_STATUSES = [
  ["AVAILABLE", "Available"],
  ["HELD", "Held"],
  ["IN_CHECKOUT", "In checkout"],
  ["SOLD", "Sold"],
] as const;

const METRICS = [
  ["hold_ok", "Holds OK"],
  ["seat_unavailable", "Seat unavailable"],
  ["race_lost", "Races lost"],
  ["booking_busy", "Busy"],
  ["limit_exceeded", "Limit exceeded"],
] as const;

function OrdersCard({ snapshot }: { readonly snapshot: AdminSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl>
          <div className="flex justify-between">
            <dt>Pending payments</dt>
            <dd className="font-semibold tabular-nums">{snapshot.pendingPayments}</dd>
          </div>
        </dl>
        <Table>
          <TableCaption>Orders by status</TableCaption>
          <TableBody>
            {ORDER_STATUSES.map(([status, label]) => (
              <TableRow key={status}>
                <TableCell>{label}</TableCell>
                <TableCell className="tabular-nums">{snapshot.orders[status]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function EventsTable({ snapshot }: { readonly snapshot: AdminSnapshot }) {
  return (
    <Table>
      <TableCaption>Seats, queue and metrics per event</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Event</TableHead>
          {SEAT_STATUSES.map(([status, label]) => (
            <TableHead key={status} scope="col">
              {label}
            </TableHead>
          ))}
          <TableHead scope="col">Queue</TableHead>
          <TableHead scope="col">Active shoppers</TableHead>
          {METRICS.map(([metric, label]) => (
            <TableHead key={metric} scope="col">
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {snapshot.events.map((event) => (
          <TableRow key={event.eventId}>
            <TableCell>{event.name}</TableCell>
            {SEAT_STATUSES.map(([status]) => (
              <TableCell key={status} className="tabular-nums">
                {event.seats[status]}
              </TableCell>
            ))}
            <TableCell className="tabular-nums">{event.queueLength}</TableCell>
            <TableCell className="tabular-nums">{event.activeShoppers}</TableCell>
            {METRICS.map(([metric]) => (
              <TableCell key={metric} data-testid={`metric-${metric}`} className="tabular-nums">
                {/* Counters are best-effort; a dash means Redis could not be read this time. */}
                {event.metrics === null ? "–" : event.metrics[metric]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

function RaceSummary({ race }: { readonly race: RaceResult }) {
  return (
    <p role="status" aria-label="Race result">
      {race.buyers} buyers: {plural(race.successes, "success", "successes")}, {race.seatUnavailable}{" "}
      seat unavailable, {race.bookingBusy} booking busy
      {race.otherErrors > 0 ? `, ${race.otherErrors} other errors` : ""} in {race.durationMs} ms.
      {race.winner === null ? null : (
        <span className="block text-muted-foreground text-sm">
          Winner's correlation id: {race.winner.correlationId}
        </span>
      )}
    </p>
  );
}

function ResetSummary({ reset }: { readonly reset: ResetDemoResult }) {
  return (
    <p role="status" aria-label="Reset result">
      Demo reset: {plural(reset.holdsDeleted, "hold")}, {plural(reset.ordersDeleted, "order")} and{" "}
      {plural(reset.ledgerRowsDeleted, "ledger row")} deleted; {plural(reset.seatsFreed, "seat")}{" "}
      freed.
    </p>
  );
}

const buttonClass =
  "rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50";

/** The demo event's race and reset. The server rate-limits both; the result shows here. */
function DemoActions() {
  const trpc = useTRPC();
  const race = useMutation(trpc.admin.runRace.mutationOptions());
  const reset = useMutation(trpc.admin.resetDemo.mutationOptions());
  const busy = race.isPending || reset.isPending;
  const failure = race.error ?? reset.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Demo event</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => {
              reset.reset();
              race.mutate();
            }}
          >
            Run race
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => {
              race.reset();
              reset.mutate();
            }}
          >
            Reset demo
          </button>
        </div>
        {race.data === undefined ? null : <RaceSummary race={race.data} />}
        {reset.data === undefined ? null : <ResetSummary reset={reset.data} />}
        {failure === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {failure.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminDashboard() {
  const trpc = useTRPC();
  const snapshot = useQuery(
    trpc.admin.snapshot.queryOptions(undefined, {
      // Polling (not a push channel) keeps the dashboard on the same tRPC path as everything
      // else; it stops once the admin session has ended, as every further poll would fail too.
      refetchInterval: (query) =>
        query.state.error?.data?.code === "UNAUTHORIZED" ? false : SNAPSHOT_POLL_MS,
    }),
  );

  if (snapshot.isPending) {
    return <p className="text-muted-foreground">Loading snapshot…</p>;
  }
  if (snapshot.isError) {
    return (
      <p role="alert" className="text-destructive">
        {snapshot.error.data?.code === "UNAUTHORIZED" ? (
          <>
            Your admin session has ended. <Link href="/admin/login">Log in</Link>
          </>
        ) : (
          "The snapshot could not be loaded."
        )}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        Updated {snapshot.data.takenAt.toLocaleTimeString("en-GB")}
      </p>
      <DemoActions />
      <OrdersCard snapshot={snapshot.data} />
      <EventsTable snapshot={snapshot.data} />
    </div>
  );
}
