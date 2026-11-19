// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppRouter } from "@/server/routers/_app";
import { TRPCProvider } from "@/trpc/react";
import { EventPage } from "./event-page";

const NOW = new Date("2027-03-01T12:00:00.000Z");
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "77777777-7777-4777-8777-777777777777";
const CORRELATION_ID = "88888888-8888-4888-8888-888888888888";
const SEAT_A1 = "55555555-5555-4555-8555-555555555555";
const SEAT_A2 = "66666666-6666-4666-8666-666666666666";

const event = {
  id: EVENT_ID,
  name: "Arena Night",
  venueName: "Budapest Arena",
  onSaleAt: new Date("2027-02-01T10:00:00.000Z"),
  queueOpensAt: new Date("2027-02-01T09:30:00.000Z"),
  queueClosesAt: new Date("2027-03-02T12:00:00.000Z"),
  demo: false,
  sections: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Floor",
      priceMinor: 9900,
      currency: "EUR",
    },
  ],
};

function seatsWith(status: "AVAILABLE" | "HELD") {
  return [
    {
      id: SEAT_A1,
      section: "Floor",
      row: "A",
      number: 1,
      status,
      priceMinor: 9900,
      currency: "EUR",
    },
    {
      id: SEAT_A2,
      section: "Floor",
      row: "A",
      number: 2,
      status,
      priceMinor: 9900,
      currency: "EUR",
    },
  ];
}

type Answer = { readonly data: unknown } | { readonly error: TrpcFailure };
type TrpcFailure = { readonly code: string; readonly httpStatus: number; readonly message: string };

/** The fake API's scripted answers; each test sets what it needs. */
let joinAnswer: Answer;
/** queue.status answers in order; the last one repeats. */
let statusAnswers: Answer[];
let holdAnswer: Answer;
let seatsHeld = false;
let calls: { procedure: string; input: unknown }[];

function callsTo(procedure: string) {
  return calls.filter((call) => call.procedure === procedure);
}

function respond(answer: Answer): Response {
  if ("data" in answer) {
    return Response.json({ result: { data: superjson.serialize(answer.data) } });
  }
  const { code, httpStatus, message } = answer.error;
  const error = { message, code: -32000, data: { code, httpStatus } };
  return Response.json({ error: superjson.serialize(error) }, { status: httpStatus });
}

/** Answers tRPC requests the way the API route does; the network is the faked boundary. */
async function fakeApi(
  input: RequestInfo | URL,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const procedure = url.pathname.replace("/api/trpc/", "");
  const rawInput = init?.method === "POST" ? init.body : url.searchParams.get("input");
  const parsed: unknown =
    typeof rawInput === "string" ? superjson.deserialize(JSON.parse(rawInput)) : undefined;
  calls.push({ procedure, input: parsed });

  switch (procedure) {
    case "events.get":
      return respond({ data: event });
    case "seats.map":
      return respond({
        data: { eventId: EVENT_ID, seats: seatsWith(seatsHeld ? "HELD" : "AVAILABLE") },
      });
    case "queue.join":
      return respond(joinAnswer);
    case "queue.status": {
      const answer = statusAnswers.length > 1 ? statusAnswers.shift() : statusAnswers[0];
      return respond(answer ?? { data: { status: "NOT_QUEUED" } });
    }
    case "booking.holdSeats":
      if ("data" in holdAnswer) {
        seatsHeld = true;
      }
      return respond(holdAnswer);
    case "booking.releaseHold":
      seatsHeld = false;
      return respond({ data: { ...heldHold(), status: "RELEASED" } });
    default:
      return respond({
        error: { code: "NOT_FOUND", httpStatus: 404, message: `No procedure ${procedure}` },
      });
  }
}

function heldHold(expiresInMs = 10 * 60_000) {
  return {
    id: HOLD_ID,
    eventId: EVENT_ID,
    seatIds: [SEAT_A1, SEAT_A2],
    status: "HELD",
    holdExpiresAt: new Date(NOW.getTime() + expiresInMs),
    correlationId: CORRELATION_ID,
  };
}

const QUEUED_AT = (position: number, etaSeconds: number): Answer => ({
  data: { status: "QUEUED", position, etaSeconds },
});
const ADMITTED: Answer = { data: { status: "ADMITTED" } };
const NOT_QUEUED: Answer = { data: { status: "NOT_QUEUED" } };

function renderEventPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/api/trpc", transformer: superjson, fetch: fakeApi })],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <EventPage eventId={EVENT_ID} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Renders the page already admitted and selects both seats. */
async function admittedWithBothSeatsSelected() {
  statusAnswers = [ADMITTED];
  renderEventPage();
  await screen.findByRole("button", { name: /^Hold/ });
  fireEvent.click(
    await screen.findByRole("button", { name: "Section Floor, row A, seat 1, €99.00, available" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Section Floor, row A, seat 2, €99.00, available" }),
  );
}

beforeEach(() => {
  joinAnswer = QUEUED_AT(3, 1);
  statusAnswers = [NOT_QUEUED];
  holdAnswer = { data: heldHold() };
  seatsHeld = false;
  calls = [];
  // Time is the faked boundary; it still advances on its own so Testing Library can wait.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Queue room", () => {
  test("shows position and ETA, polls queue.status every 3 s and advances on admission", async () => {
    statusAnswers = [NOT_QUEUED, QUEUED_AT(3, 1), QUEUED_AT(2, 1), ADMITTED];
    renderEventPage();

    fireEvent.click(await screen.findByRole("button", { name: "Join the queue" }));

    const room = await screen.findByRole("region", { name: "Queue room" });
    expect((await within(room).findByText(/Position 3/)).textContent).toContain("Position 3");
    expect(room.textContent).toContain("about 1 second");
    expect(screen.queryByRole("button", { name: /^Hold/ })).toBeNull();
    const polls = callsTo("queue.status").length;

    await advance(3000);
    expect(callsTo("queue.status")).toHaveLength(polls + 1);
    expect(room.textContent).toContain("Position 2");

    await advance(3000);
    expect(callsTo("queue.status")).toHaveLength(polls + 2);
    expect(screen.queryByRole("region", { name: "Queue room" })).toBeNull();
    expect(screen.getByRole("status", { name: "Admission" }).textContent).toContain(
      "It's your turn",
    );
    expect(screen.getByRole("button", { name: /^Hold/ })).toBeTruthy();
  });

  test("a queue that has not opened yet says when it opens", async () => {
    joinAnswer = { data: { status: "NOT_OPEN", queueOpensAt: new Date("2027-03-01T13:30:00Z") } };
    renderEventPage();

    fireEvent.click(await screen.findByRole("button", { name: "Join the queue" }));

    const notice = await screen.findByText(/The queue opens/);
    expect(notice.textContent).toContain("Mar 1, 2027");
    expect(screen.queryByRole("region", { name: "Queue room" })).toBeNull();
  });

  test("an immediate admission polls queue.status before offering to hold", async () => {
    joinAnswer = { data: { status: "ADMISSIBLE" } };
    statusAnswers = [NOT_QUEUED, ADMITTED];
    renderEventPage();
    fireEvent.click(await screen.findByRole("button", { name: "Join the queue" }));

    await screen.findByRole("button", { name: /^Hold/ });

    const joinedAt = calls.findIndex((call) => call.procedure === "queue.join");
    expect(calls.slice(joinedAt).some((call) => call.procedure === "queue.status")).toBe(true);
  });
});

describe("Holding seats", () => {
  test("a successful hold sends the selected seats of this event", async () => {
    await admittedWithBothSeatsSelected();

    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));

    await screen.findByRole("region", { name: "Your hold" });
    expect(callsTo("booking.holdSeats").map((call) => call.input)).toEqual([
      { eventId: EVENT_ID, seatIds: [SEAT_A1, SEAT_A2] },
    ]);
  });

  test.each([
    {
      name: "SEAT_UNAVAILABLE names the taken seats",
      error: {
        code: "CONFLICT",
        httpStatus: 409,
        message: `SEAT_UNAVAILABLE: ${SEAT_A2}`,
      },
      expected: ["just taken", "Section Floor, row A, seat 2"],
      absent: ["row A, seat 1"],
    },
    {
      name: "LIMIT_EXCEEDED explains the 6-seat limit",
      error: {
        code: "CONFLICT",
        httpStatus: 409,
        message: "LIMIT_EXCEEDED: 5 seat(s) in use plus 2 requested exceeds 6",
      },
      expected: ["at most 6 seats"],
      absent: ["just taken"],
    },
    {
      name: "BOOKING_BUSY asks to retry",
      error: {
        code: "TOO_MANY_REQUESTS",
        httpStatus: 429,
        message: "BOOKING_BUSY: the booking system is saturated, retry shortly",
      },
      expected: ["busy", "try again"],
      absent: ["just taken"],
    },
    {
      name: "FORBIDDEN asks to rejoin the queue",
      error: {
        code: "FORBIDDEN",
        httpStatus: 403,
        message: `No valid admission for event ${EVENT_ID}; join its queue first`,
      },
      expected: ["admission", "join the queue again"],
      absent: ["just taken"],
    },
  ])("$name", async ({ error, expected, absent }) => {
    holdAnswer = { error };
    await admittedWithBothSeatsSelected();

    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));

    const alert = await screen.findByRole("alert");
    for (const text of expected) {
      expect(alert.textContent?.toLowerCase()).toContain(text.toLowerCase());
    }
    for (const text of absent) {
      expect(alert.textContent?.toLowerCase()).not.toContain(text.toLowerCase());
    }
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
  });

  test("FORBIDDEN stays on screen and the join button returns once the admission is gone", async () => {
    holdAnswer = {
      error: { code: "FORBIDDEN", httpStatus: 403, message: "No valid admission" },
    };
    await admittedWithBothSeatsSelected();
    statusAnswers = [NOT_QUEUED];

    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));

    await screen.findByRole("button", { name: "Join the queue" });
    expect(screen.getByRole("alert").textContent).toContain("join the queue again");
    expect(screen.queryByRole("button", { name: /^Hold/ })).toBeNull();
  });

  test("a live hold stays on screen when the admission lapses", async () => {
    await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    await screen.findByRole("region", { name: "Your hold" });
    statusAnswers = [NOT_QUEUED];

    await advance(3000);

    expect(screen.getByRole("button", { name: "Join the queue" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your hold" })).toBeTruthy();
    expect(screen.getByRole("timer")).toBeTruthy();
  });

  test("the four refusals are four different messages", async () => {
    const messages: string[] = [];
    for (const error of [
      { code: "CONFLICT", httpStatus: 409, message: `SEAT_UNAVAILABLE: ${SEAT_A1}` },
      { code: "CONFLICT", httpStatus: 409, message: "LIMIT_EXCEEDED: 6 + 2 exceeds 6" },
      { code: "TOO_MANY_REQUESTS", httpStatus: 429, message: "BOOKING_BUSY: retry" },
      { code: "FORBIDDEN", httpStatus: 403, message: "No valid admission" },
    ]) {
      holdAnswer = { error };
      await admittedWithBothSeatsSelected();
      fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
      messages.push((await screen.findByRole("alert")).textContent ?? "");
      cleanup();
    }

    expect(new Set(messages).size).toBe(4);
  });
});

describe("Hold countdown and release", () => {
  test("counts down to the server's holdExpiresAt", async () => {
    await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));

    const timer = await screen.findByRole("timer");
    expect(timer.textContent).toBe("10:00");

    await advance(1000);
    expect(timer.textContent).toBe("9:59");

    await advance(59_000);
    expect(timer.textContent).toBe("9:00");
  });

  test("when the countdown ends the hold is gone and the buyer is told", async () => {
    holdAnswer = { data: heldHold(5_000) };
    await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    await screen.findByRole("timer");

    await advance(5_000);

    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Your hold expired");
  });

  test("the release button releases the hold", async () => {
    await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    const hold = await screen.findByRole("region", { name: "Your hold" });
    expect(hold.textContent).toContain("Section Floor, row A, seat 1");

    fireEvent.click(within(hold).getByRole("button", { name: "Release seats" }));

    await screen.findByText(/Seats released/);
    expect(callsTo("booking.releaseHold").map((call) => call.input)).toEqual([{ holdId: HOLD_ID }]);
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
  });
});

describe("Heartbeat", () => {
  test("the seat map keeps polling queue.status and seats.map every 3 s once admitted", async () => {
    await admittedWithBothSeatsSelected();
    const statusPolls = callsTo("queue.status").length;
    const seatPolls = callsTo("seats.map").length;

    await advance(9000);

    expect(callsTo("queue.status")).toHaveLength(statusPolls + 3);
    expect(callsTo("seats.map")).toHaveLength(seatPolls + 3);
  });

  test("polling continues while seats are held", async () => {
    await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    await screen.findByRole("timer");
    const statusPolls = callsTo("queue.status").length;

    await advance(9000);

    expect(callsTo("queue.status")).toHaveLength(statusPolls + 3);
  });

  test("a visitor who has not joined is not polled", async () => {
    renderEventPage();
    await screen.findByRole("button", { name: "Join the queue" });
    const statusPolls = callsTo("queue.status").length;

    await advance(9000);

    expect(callsTo("queue.status")).toHaveLength(statusPolls);
  });
});
