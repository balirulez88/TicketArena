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
type TrpcFailure = {
  readonly code: string;
  readonly httpStatus: number;
  readonly message: string;
  /** What the server's error formatter adds for a mapped domain error. */
  readonly domainCode?: string;
  readonly seatIds?: readonly string[];
};

/** The fake API's scripted answers; each test sets what it needs. */
let joinAnswer: Answer;
/** queue.status answers in order; the last one repeats. */
let statusAnswers: Answer[];
let holdAnswer: Answer;
/** booking.releaseHold's answer; `null` releases the held seats. */
let releaseAnswer: Answer | null;
/** booking.activeHold's answer: what the server still holds for this session after a reload. */
let activeHoldAnswer: Answer;
/** While set, booking.activeHold answers only once it resolves: a slow restore read. */
let activeHoldDelay: Promise<void> | null;
let seatsHeld = false;
let calls: { procedure: string; input: unknown }[];

function callsTo(procedure: string) {
  return calls.filter((call) => call.procedure === procedure);
}

function respond(answer: Answer): Response {
  if ("data" in answer) {
    return Response.json({ result: { data: superjson.serialize(answer.data) } });
  }
  const { message, ...data } = answer.error;
  const error = { message, code: -32000, data };
  return Response.json({ error: superjson.serialize(error) }, { status: data.httpStatus });
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
    case "booking.activeHold":
      if (activeHoldDelay !== null) {
        await activeHoldDelay;
      }
      return respond(activeHoldAnswer);
    case "booking.releaseHold":
      seatsHeld = false;
      return respond(releaseAnswer ?? { data: { ...heldHold(), status: "RELEASED" } });
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

/** Renders the page; pass the previous render's client to remount as in-app navigation does. */
function renderEventPage(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "http://localhost/api/trpc", transformer: superjson, fetch: fakeApi })],
  });
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <EventPage eventId={EVENT_ID} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
  return { queryClient, unmount };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Renders the page already admitted and selects both seats. */
async function admittedWithBothSeatsSelected() {
  statusAnswers = [ADMITTED];
  const page = renderEventPage();
  await screen.findByRole("button", { name: /^Hold/ });
  fireEvent.click(
    await screen.findByRole("button", { name: "Section Floor, row A, seat 1, €99.00, available" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Section Floor, row A, seat 2, €99.00, available" }),
  );
  return page;
}

beforeEach(() => {
  joinAnswer = QUEUED_AT(3, 1);
  statusAnswers = [NOT_QUEUED];
  holdAnswer = { data: heldHold() };
  releaseAnswer = null;
  activeHoldAnswer = { data: null };
  activeHoldDelay = null;
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
        message: "Refused",
        domainCode: "SEAT_UNAVAILABLE",
        seatIds: [SEAT_A2],
      },
      expected: ["just taken", "Section Floor, row A, seat 2"],
      absent: ["row A, seat 1"],
    },
    {
      name: "LIMIT_EXCEEDED explains the 6-seat limit",
      error: {
        code: "CONFLICT",
        httpStatus: 409,
        message: "Refused",
        domainCode: "LIMIT_EXCEEDED",
      },
      expected: ["at most 6 seats"],
      absent: ["just taken"],
    },
    {
      name: "BOOKING_BUSY asks to retry",
      error: {
        code: "TOO_MANY_REQUESTS",
        httpStatus: 429,
        message: "Refused",
        domainCode: "BOOKING_BUSY",
      },
      expected: ["busy", "try again"],
      absent: ["just taken"],
    },
    {
      name: "NOT_ON_SALE says tickets are not on sale yet",
      error: {
        code: "PRECONDITION_FAILED",
        httpStatus: 412,
        message: "Refused",
        domainCode: "NOT_ON_SALE",
      },
      expected: ["not on sale yet"],
      absent: ["just taken"],
    },
    {
      name: "a refusal without a domain code is the generic failure, whatever its message says",
      error: {
        code: "CONFLICT",
        httpStatus: 409,
        message: `SEAT_UNAVAILABLE: ${SEAT_A2}`,
      },
      expected: ["could not be held"],
      absent: ["just taken", "at most 6 seats"],
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
      {
        code: "CONFLICT",
        httpStatus: 409,
        message: "Refused",
        domainCode: "SEAT_UNAVAILABLE",
        seatIds: [SEAT_A1],
      },
      { code: "CONFLICT", httpStatus: 409, message: "Refused", domainCode: "LIMIT_EXCEEDED" },
      {
        code: "TOO_MANY_REQUESTS",
        httpStatus: 429,
        message: "Refused",
        domainCode: "BOOKING_BUSY",
      },
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

  test("a release refused with HOLD_EXPIRED ends the hold and says it expired", async () => {
    releaseAnswer = {
      error: {
        code: "PRECONDITION_FAILED",
        httpStatus: 412,
        message: "Refused",
        domainCode: "HOLD_EXPIRED",
      },
    };
    await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    const hold = await screen.findByRole("region", { name: "Your hold" });

    fireEvent.click(within(hold).getByRole("button", { name: "Release seats" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Your hold expired");
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
  });
});

/** What activeHold returns: the holdSeats shape plus the seats priced. */
function restoredHold(expiresInMs = 10 * 60_000) {
  return {
    ...heldHold(expiresInMs),
    seats: [SEAT_A1, SEAT_A2].map((id) => ({ id, priceMinor: 9900, currency: "EUR" })),
  };
}

describe("A reload restores the active hold", () => {
  test("shows the session's live hold with its countdown, asking for this event", async () => {
    activeHoldAnswer = { data: restoredHold(4 * 60_000) };
    seatsHeld = true;
    renderEventPage();

    const hold = await screen.findByRole("region", { name: "Your hold" });
    expect(hold.textContent).toContain("Section Floor, row A, seat 1");
    expect(hold.textContent).toContain("Section Floor, row A, seat 2");
    expect(within(hold).getByRole("form", { name: "Checkout" })).toBeTruthy();
    const timer = within(hold).getByRole("timer");
    expect(timer.textContent).toBe("4:00");
    await advance(1000);
    expect(timer.textContent).toBe("3:59");
    expect(callsTo("booking.activeHold").map((call) => call.input)).toEqual([
      { eventId: EVENT_ID },
    ]);
  });

  test("a restored hold can be released, and it stays gone", async () => {
    activeHoldAnswer = { data: restoredHold() };
    seatsHeld = true;
    renderEventPage();
    const hold = await screen.findByRole("region", { name: "Your hold" });

    fireEvent.click(within(hold).getByRole("button", { name: "Release seats" }));

    await screen.findByText(/Seats released/);
    expect(callsTo("booking.releaseHold").map((call) => call.input)).toEqual([{ holdId: HOLD_ID }]);
    await advance(3000);
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
  });

  test("a restored hold ends at its deadline like any other", async () => {
    activeHoldAnswer = { data: restoredHold(5_000) };
    seatsHeld = true;
    renderEventPage();
    await screen.findByRole("region", { name: "Your hold" });

    await advance(5_000);

    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Your hold expired");
  });

  test("with no live hold on the server (expired or released while closed) none is shown", async () => {
    activeHoldAnswer = { data: null };
    statusAnswers = [ADMITTED];
    renderEventPage();

    await screen.findByRole("button", { name: /^Hold/ });
    await screen.findByRole("button", { name: "Section Floor, row A, seat 1, €99.00, available" });
    expect(callsTo("booking.activeHold")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
  });

  test("a hold made on the page is shown again after navigating away and back", async () => {
    const { queryClient, unmount } = await admittedWithBothSeatsSelected();
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    await screen.findByRole("region", { name: "Your hold" });
    // The first visit cached activeHold's `null`; the server now holds the seats.
    activeHoldAnswer = { data: restoredHold() };

    unmount();
    renderEventPage(queryClient);

    const hold = await screen.findByRole("region", { name: "Your hold" });
    expect(within(hold).getByRole("button", { name: "Release seats" })).toBeTruthy();
    expect(callsTo("booking.activeHold")).toHaveLength(2);
  });

  test("a hold ended in another tab is not brought back from the cache on remount", async () => {
    activeHoldAnswer = { data: restoredHold() };
    seatsHeld = true;
    const { queryClient, unmount } = renderEventPage();
    await screen.findByRole("region", { name: "Your hold" });
    activeHoldAnswer = { data: null };

    unmount();
    renderEventPage(queryClient);

    await vi.waitFor(() => expect(callsTo("booking.activeHold")).toHaveLength(2));
    await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull());
  });

  test("a restore answer that arrives after the hold was released does not bring it back", async () => {
    let answerRestore: (() => void) | undefined;
    activeHoldDelay = new Promise((resolve) => {
      answerRestore = resolve;
    });
    await admittedWithBothSeatsSelected();
    await vi.waitFor(() => expect(callsTo("booking.activeHold")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Hold 2 seats" }));
    const hold = await screen.findByRole("region", { name: "Your hold" });
    fireEvent.click(within(hold).getByRole("button", { name: "Release seats" }));
    await screen.findByText(/Seats released/);

    // The read started before the hold existed and answers as if it were still live.
    activeHoldAnswer = { data: restoredHold() };
    answerRestore?.();
    await advance(1000);

    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
    expect(screen.getByText(/Seats released/)).toBeTruthy();
  });

  test("a cached hold expiring during the remount read does not cancel the newer live hold", async () => {
    activeHoldAnswer = { data: restoredHold(3000) };
    seatsHeld = true;
    const { queryClient, unmount } = renderEventPage();
    await screen.findByRole("region", { name: "Your hold" });
    unmount();

    let answerRestore: (() => void) | undefined;
    activeHoldDelay = new Promise((resolve) => {
      answerRestore = resolve;
    });
    const newerHoldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const newerSeatId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    activeHoldAnswer = {
      data: {
        ...restoredHold(),
        id: newerHoldId,
        seatIds: [newerSeatId],
        seats: [{ id: newerSeatId, priceMinor: 9900, currency: "EUR" }],
      },
    };
    renderEventPage(queryClient);
    await vi.waitFor(() => expect(callsTo("booking.activeHold")).toHaveLength(2));

    // The cached hold's deadline passes while the fresh read is still out.
    await advance(4000);
    answerRestore?.();
    await advance(1000);

    const hold = await screen.findByRole("region", { name: "Your hold" });
    expect(hold.textContent).toContain("a seat no longer on the map");
    expect(hold.textContent).not.toContain("row A, seat 1");
    expect(screen.queryByText(/Your hold expired/)).toBeNull();
    fireEvent.click(within(hold).getByRole("button", { name: "Release seats" }));
    await vi.waitFor(() =>
      expect(callsTo("booking.releaseHold").map((call) => call.input)).toEqual([
        { holdId: newerHoldId },
      ]),
    );
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
