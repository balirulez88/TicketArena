"use client";

import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { SeatMap } from "@/components/seat-map/seat-map";
import { SeatSelectionProvider } from "@/components/seat-map/seat-selection";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPrice } from "@/lib/format";
import type { AppRouter } from "@/server/routers/_app";
import { useTRPC } from "@/trpc/react";
import { OnSaleStatus } from "./on-sale-status";

type EventDetail = inferRouterOutputs<AppRouter>["events"]["get"];

function EventDetails({ event }: { readonly event: EventDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-3xl tracking-tight">{event.name}</h1>
        </CardTitle>
        <CardDescription>{event.venueName}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <OnSaleStatus onSaleAt={event.onSaleAt} />
        <Table>
          <TableCaption>Prices per section</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Section</TableHead>
              <TableHead scope="col">Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {event.sections.map((section) => (
              <TableRow key={section.id}>
                <TableCell>{section.name}</TableCell>
                <TableCell>{formatPrice(section.priceMinor, section.currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function EventSeats({ eventId }: { readonly eventId: string }) {
  const trpc = useTRPC();
  const seatMap = useQuery(trpc.seats.map.queryOptions({ eventId }));

  if (seatMap.isPending) {
    return <p className="text-muted-foreground">Loading seats…</p>;
  }
  if (seatMap.isError) {
    return (
      <p role="alert" className="text-destructive">
        Seats could not be loaded.
      </p>
    );
  }
  return (
    // Keyed by event so moving to another event starts with an empty selection.
    <SeatSelectionProvider key={eventId}>
      <SeatMap seats={seatMap.data.seats} />
    </SeatSelectionProvider>
  );
}

/** A malformed id in the URL is as missing to a visitor as an unknown one. */
function isMissing(code: string | undefined): boolean {
  return code === "NOT_FOUND" || code === "BAD_REQUEST";
}

export function EventPage({ eventId }: { readonly eventId: string }) {
  const trpc = useTRPC();
  const event = useQuery(trpc.events.get.queryOptions({ eventId }));

  if (event.isPending) {
    return <p className="text-muted-foreground">Loading event…</p>;
  }
  if (event.isError) {
    return (
      <p role="alert" className="text-destructive">
        {isMissing(event.error.data?.code) ? "Event not found." : "Event could not be loaded."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <EventDetails event={event.data} />
      <section aria-labelledby="seat-map-heading" className="flex flex-col gap-4">
        <h2 id="seat-map-heading" className="font-semibold text-xl">
          Seat map
        </h2>
        <EventSeats eventId={eventId} />
      </section>
    </div>
  );
}
