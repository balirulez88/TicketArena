import type { Metadata } from "next";
import { EventsList } from "@/components/events/events-list";

export const metadata: Metadata = { title: "Events · TicketArena" };

export default function EventsPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-12">
      <h1 className="font-semibold text-3xl tracking-tight">Events</h1>
      <EventsList />
    </main>
  );
}
