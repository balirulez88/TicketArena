// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppRouter } from "@/server/routers/_app";
import { TRPCProvider } from "@/trpc/react";
import { EventPage } from "./event-page";
import { EventsList } from "./events-list";

const NOW = new Date("2027-03-01T12:00:00.000Z");
const ON_SALE_EVENT = "11111111-1111-4111-8111-111111111111";
const UPCOMING_EVENT = "22222222-2222-4222-8222-222222222222";

const events = [
  {
    id: ON_SALE_EVENT,
    name: "Arena Night",
    venueName: "Budapest Arena",
    onSaleAt: new Date("2027-02-01T10:00:00.000Z"),
    queueOpensAt: new Date("2027-02-01T09:30:00.000Z"),
    queueClosesAt: new Date("2027-02-01T12:00:00.000Z"),
    demo: true,
  },
  {
    id: UPCOMING_EVENT,
    name: "Summer Gala",
    venueName: "Opera House",
    onSaleAt: new Date("2027-04-01T10:00:00.000Z"),
    queueOpensAt: new Date("2027-04-01T09:30:00.000Z"),
    queueClosesAt: new Date("2027-04-01T12:00:00.000Z"),
    demo: false,
  },
];

const sections = [
  { id: "33333333-3333-4333-8333-333333333333", name: "Floor", priceMinor: 9900, currency: "EUR" },
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Balcony",
    priceMinor: 4550,
    currency: "EUR",
  },
];

const seats = [
  {
    id: "55555555-5555-4555-8555-555555555555",
    section: "Balcony",
    row: "A",
    number: 1,
    status: "SOLD",
    priceMinor: 4550,
    currency: "EUR",
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    section: "Floor",
    row: "A",
    number: 1,
    status: "AVAILABLE",
    priceMinor: 9900,
    currency: "EUR",
  },
];

/** Answers tRPC GET requests the way the API route does; the network is the faked boundary. */
async function fakeApi(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const procedure = url.pathname.replace("/api/trpc/", "");
  const rawInput = url.searchParams.get("input");
  const parsed: unknown =
    rawInput === null ? undefined : superjson.deserialize(JSON.parse(rawInput));
  const eventId =
    typeof parsed === "object" && parsed !== null && "eventId" in parsed
      ? parsed.eventId
      : undefined;
  const event = events.find((candidate) => candidate.id === eventId);

  if (procedure === "events.list") {
    return ok(events);
  }
  if (event === undefined) {
    return notFound(`Event ${String(eventId)} not found`);
  }
  if (procedure === "events.get") {
    return ok({ ...event, sections });
  }
  if (procedure === "seats.map") {
    return ok({ eventId: event.id, seats });
  }
  return notFound(`No procedure ${procedure}`);
}

function ok(data: unknown): Response {
  return Response.json({ result: { data: superjson.serialize(data) } });
}

function notFound(message: string): Response {
  const error = { message, code: -32004, data: { code: "NOT_FOUND", httpStatus: 404 } };
  return Response.json({ error: superjson.serialize(error) }, { status: 404 });
}

function renderWithApi(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/api/trpc", transformer: superjson, fetch: fakeApi })],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {ui}
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("EventsList", () => {
  test("lists each event with its venue, on-sale date, status and a link to its page", async () => {
    renderWithApi(<EventsList />);

    const arena = await screen.findByRole("link", { name: "Arena Night" });
    expect(arena.getAttribute("href")).toBe(`/events/${ON_SALE_EVENT}`);
    expect(screen.getByRole("link", { name: "Summer Gala" }).getAttribute("href")).toBe(
      `/events/${UPCOMING_EVENT}`,
    );

    const [first, second] = screen.getAllByRole("listitem");
    expect(first?.textContent).toContain("Budapest Arena");
    expect(first?.textContent).toContain("On sale now");
    expect(second?.textContent).toContain("Opera House");
    expect(second?.textContent).toContain("Upcoming");
    expect(second?.textContent).toContain("Apr 1, 2027");
  });
});

describe("EventPage", () => {
  test("shows the event's venue, on-sale status, section prices and its seat map", async () => {
    renderWithApi(<EventPage eventId={ON_SALE_EVENT} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Arena Night" })).toBeTruthy();
    expect(document.body.textContent).toContain("Budapest Arena");
    expect(document.body.textContent).toContain("On sale now");
    const prices = screen.getByRole("table", { name: "Prices per section" });
    expect(prices.textContent).toContain("Floor");
    expect(prices.textContent).toContain("€99.00");
    expect(prices.textContent).toContain("Balcony");
    expect(prices.textContent).toContain("€45.50");

    expect(
      await screen.findByRole("button", {
        name: "Section Floor, row A, seat 1, €99.00, available",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Section Balcony, row A, seat 1, €45.50, sold" }),
    ).toBeTruthy();
  });

  test("an unknown event says it was not found", async () => {
    renderWithApi(<EventPage eventId="00000000-0000-4000-8000-000000000000" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Event not found");
  });
});
