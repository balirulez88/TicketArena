"use client";

import { useQuery } from "@tanstack/react-query";
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
import type { AdminSnapshot } from "@/server/routers/admin";
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
      <OrdersCard snapshot={snapshot.data} />
      <EventsTable snapshot={snapshot.data} />
    </div>
  );
}
