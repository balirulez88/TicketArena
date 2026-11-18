"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTRPC } from "@/trpc/react";
import { OnSaleStatus } from "./on-sale-status";

export function EventsList() {
  const trpc = useTRPC();
  const events = useQuery(trpc.events.list.queryOptions());

  if (events.isPending) {
    return <p className="text-muted-foreground">Loading events…</p>;
  }
  if (events.isError) {
    return (
      <p role="alert" className="text-destructive">
        Events could not be loaded.
      </p>
    );
  }
  if (events.data.length === 0) {
    return <p className="text-muted-foreground">No events yet.</p>;
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {events.data.map((event) => (
        <li key={event.id}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>
                <Link href={`/events/${event.id}`} className="hover:underline">
                  {event.name}
                </Link>
              </CardTitle>
              <CardDescription>{event.venueName}</CardDescription>
            </CardHeader>
            <CardContent>
              <OnSaleStatus onSaleAt={event.onSaleAt} />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
