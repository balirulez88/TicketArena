import { ApiStatus } from "./api-status";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-24">
      <h1 className="font-semibold text-4xl tracking-tight">TicketArena</h1>
      <p className="text-lg text-muted-foreground">
        Fair, high-traffic ticket sales behind a digital waiting room.
      </p>
      <ApiStatus />
    </main>
  );
}
