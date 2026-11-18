import Link from "next/link";
import { EventPage } from "@/components/events/event-page";

export default async function EventRoute({
  params,
}: {
  readonly params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-12">
      <Link href="/events" className="text-muted-foreground text-sm hover:underline">
        ← All events
      </Link>
      <EventPage eventId={eventId} />
    </main>
  );
}
