// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventPage } from "@/components/events/event-page";
import type { AppRouter } from "@/server/routers/_app";
import { TRPCProvider } from "@/trpc/react";
import { OrderStatus } from "./order-status";

const NOW = new Date("2027-03-01T12:00:00.000Z");
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_HOLD_ID = "77777777-7777-4777-8777-777777777778";
const ORDER_ID = "99999999-9999-4999-8999-999999999999";
const CORRELATION_ID = "88888888-8888-4888-8888-888888888888";
const SEAT_A1 = "55555555-5555-4555-8555-555555555555";

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

const seats = [
  {
    id: SEAT_A1,
    section: "Floor",
    row: "A",
    number: 1,
    status: "AVAILABLE",
    priceMinor: 9900,
    currency: "EUR",
  },
];

type OrderState = "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
type TrpcFailure = { readonly code: string; readonly httpStatus: number; readonly message: string };
type Answer = { readonly data: unknown } | { readonly error: TrpcFailure } | "NETWORK_DOWN";

function order(status: OrderState) {
  return {
    id: ORDER_ID,
    holdId: HOLD_ID,
    status,
    totalMinor: 9900,
    currency: "EUR",
    paymentDeadline: new Date(NOW.getTime() + 5 * 60_000),
    correlationId: CORRELATION_ID,
    contact: { email: "alice@example.com" },
    lines: [{ seatId: SEAT_A1, priceMinor: 9900, currency: "EUR" }],
  };
}

function hold(id: string) {
  return {
    id,
    eventId: EVENT_ID,
    seatIds: [SEAT_A1],
    status: "HELD",
    holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
    correlationId: CORRELATION_ID,
  };
}

/** placeOrder answers in order; the last one repeats. */
let placeOrderAnswers: Answer[];
/** getOrder answers in order; the last one repeats. */
let getOrderAnswers: Answer[];
let holdIds: string[];
/** While true, `seats.map` fails like a server error, as a background refresh can. */
let seatMapDown: boolean;
let calls: { procedure: string; input: unknown }[];

function callsTo(procedure: string) {
  return calls.filter((call) => call.procedure === procedure);
}

function next(answers: Answer[]): Answer {
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  return answer ?? { error: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, message: "none" } };
}

function respond(answer: Answer): Response {
  if (answer === "NETWORK_DOWN") {
    throw new TypeError("Failed to fetch");
  }
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
      return seatMapDown
        ? respond({ error: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, message: "down" } })
        : respond({ data: { eventId: EVENT_ID, seats } });
    case "queue.status":
      return respond({ data: { status: "ADMITTED" } });
    case "booking.holdSeats":
      return respond({ data: hold(holdIds.shift() ?? HOLD_ID) });
    case "booking.releaseHold":
      return respond({ data: { ...hold(HOLD_ID), status: "RELEASED" } });
    case "booking.placeOrder":
      return respond(next(placeOrderAnswers));
    case "booking.getOrder":
      return respond(next(getOrderAnswers));
    default:
      return respond({
        error: { code: "NOT_FOUND", httpStatus: 404, message: `No procedure ${procedure}` },
      });
  }
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

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Renders the event page admitted, holds seat A1 and returns the checkout form. */
async function holdingOneSeat() {
  renderWithApi(<EventPage eventId={EVENT_ID} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Section Floor, row A, seat 1, €99.00, available" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold 1 seat" }));
  return screen.findByRole("form", { name: "Checkout" });
}

function fillContact(form: HTMLElement, email: string, phone = "") {
  fireEvent.change(within(form).getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(within(form).getByLabelText("Phone (optional)"), { target: { value: phone } });
}

function submit(form: HTMLElement) {
  fireEvent.click(within(form).getByRole("button", { name: "Place order" }));
}

function placeOrderKeys(): unknown[] {
  return callsTo("booking.placeOrder").map((call) =>
    typeof call.input === "object" && call.input !== null && "idempotencyKey" in call.input
      ? call.input.idempotencyKey
      : undefined,
  );
}

let keyCount: number;

beforeEach(() => {
  placeOrderAnswers = [{ data: order("PENDING_PAYMENT") }];
  getOrderAnswers = [{ data: order("PENDING_PAYMENT") }];
  holdIds = [HOLD_ID, SECOND_HOLD_ID];
  seatMapDown = false;
  calls = [];
  keyCount = 0;
  // Randomness is a faked boundary: each generated idempotency key is distinct and predictable.
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    keyCount += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${String(keyCount).padStart(12, "0")}`;
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Checkout form", () => {
  test("places the order for the hold with the contact and an idempotency key", async () => {
    const form = await holdingOneSeat();

    fillContact(form, "  alice@example.com ", " +36 1 234 5678 ");
    submit(form);

    await screen.findByRole("region", { name: "Order status" });
    expect(callsTo("booking.placeOrder").map((call) => call.input)).toEqual([
      {
        holdId: HOLD_ID,
        contact: { email: "alice@example.com", phone: "+36 1 234 5678" },
        idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      },
    ]);
  });

  test("an empty phone is left out of the contact", async () => {
    const form = await holdingOneSeat();

    fillContact(form, "alice@example.com");
    submit(form);

    await screen.findByRole("region", { name: "Order status" });
    expect(callsTo("booking.placeOrder")[0]?.input).toMatchObject({
      contact: { email: "alice@example.com" },
    });
    expect(callsTo("booking.placeOrder")[0]?.input).not.toHaveProperty("contact.phone");
  });

  test.each([
    { email: "", phone: "", field: "Email", text: "valid email" },
    { email: "not-an-email", phone: "", field: "Email", text: "valid email" },
    { email: "alice@example.com", phone: "call me", field: "Phone (optional)", text: "phone" },
    { email: "alice@example.com", phone: "+36", field: "Phone (optional)", text: "phone" },
  ])(
    "invalid input ($email / $phone) is refused before any request",
    async ({ email, phone, field, text }) => {
      const form = await holdingOneSeat();

      fillContact(form, email, phone);
      submit(form);

      const input = within(form).getByLabelText(field);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const describedBy = input.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent?.toLowerCase()).toContain(text);
      await advance(100);
      expect(callsTo("booking.placeOrder")).toHaveLength(0);
    },
  );

  test("a retry after a network error reuses the idempotency key", async () => {
    placeOrderAnswers = ["NETWORK_DOWN", { data: order("PENDING_PAYMENT") }];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");

    submit(form);
    expect((await within(form).findByRole("alert")).textContent).toContain("try again");
    submit(form);

    await screen.findByRole("region", { name: "Order status" });
    const keys = placeOrderKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test("changed contact details are a new checkout attempt with a new key", async () => {
    placeOrderAnswers = [
      { error: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, message: "boom" } },
      { data: order("PENDING_PAYMENT") },
    ];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");

    fillContact(form, "bob@example.com");
    submit(form);

    await screen.findByRole("region", { name: "Order status" });
    const keys = placeOrderKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("a new hold is a new checkout attempt with a new key", async () => {
    placeOrderAnswers = [
      { error: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, message: "boom" } },
    ];
    let form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Release seats" }));
    await screen.findByText(/Seats released/);
    fireEvent.click(
      screen.getByRole("button", { name: "Section Floor, row A, seat 1, €99.00, available" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hold 1 seat" }));
    form = await screen.findByRole("form", { name: "Checkout" });

    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");

    const placed = callsTo("booking.placeOrder").map((call) => call.input);
    expect(placed).toMatchObject([{ holdId: HOLD_ID }, { holdId: SECOND_HOLD_ID }]);
    const keys = placeOrderKeys();
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("the heartbeat keeps polling queue.status during checkout", async () => {
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    const polls = callsTo("queue.status").length;

    await advance(9000);

    expect(callsTo("queue.status")).toHaveLength(polls + 3);
  });
});

describe("Checkout refusals", () => {
  test("HOLD_EXPIRED says the hold ran out and asks to choose seats again", async () => {
    placeOrderAnswers = [
      {
        error: {
          code: "PRECONDITION_FAILED",
          httpStatus: 412,
          message: `HOLD_EXPIRED: ${HOLD_ID}`,
        },
      },
    ];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");

    submit(form);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your hold expired before your order was placed");
    expect(alert.textContent).toContain("choose seats again");
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
  });

  test("IDEMPOTENCY_KEY_REUSED says the checkout was already submitted with other details", async () => {
    placeOrderAnswers = [
      {
        error: {
          code: "CONFLICT",
          httpStatus: 409,
          message: "IDEMPOTENCY_KEY_REUSED: aaaaaaaa was used for a different request",
        },
      },
      { data: order("PENDING_PAYMENT") },
    ];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");

    submit(form);

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("already submitted with different details");
    submit(form);
    await screen.findByRole("region", { name: "Order status" });
    const keys = placeOrderKeys();
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("HOLD_EXPIRED, IDEMPOTENCY_KEY_REUSED and other failures are different messages", async () => {
    const messages: string[] = [];
    for (const error of [
      { code: "PRECONDITION_FAILED", httpStatus: 412, message: `HOLD_EXPIRED: ${HOLD_ID}` },
      { code: "CONFLICT", httpStatus: 409, message: "IDEMPOTENCY_KEY_REUSED: key" },
      { code: "CONFLICT", httpStatus: 409, message: `HOLD_NOT_ACTIVE: hold ${HOLD_ID} is ORDERED` },
    ]) {
      placeOrderAnswers = [{ error }];
      holdIds = [HOLD_ID];
      const form = await holdingOneSeat();
      fillContact(form, "alice@example.com");
      submit(form);
      messages.push((await screen.findByRole("alert")).textContent ?? "");
      cleanup();
    }

    expect(new Set(messages).size).toBe(3);
  });
});

describe("Purchase state across background failures", () => {
  test("a failed seat-map refresh keeps the hold, the checkout and its key, through recovery", async () => {
    placeOrderAnswers = ["NETWORK_DOWN", { data: order("PENDING_PAYMENT") }];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");

    seatMapDown = true;
    await advance(3_000);
    expect(await screen.findByText(/seat map could not be refreshed/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your hold" })).toBeTruthy();

    seatMapDown = false;
    await advance(3_000);
    expect(screen.queryByText(/seat map could not be refreshed/i)).toBeNull();
    const sameForm = screen.getByRole("form", { name: "Checkout" });
    expect((within(sameForm).getByLabelText("Email") as HTMLInputElement).value).toBe(
      "alice@example.com",
    );
    submit(sameForm);

    await screen.findByRole("region", { name: "Order status" });
    const keys = placeOrderKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("Checkout at the hold deadline", () => {
  test("an unresolved checkout is replayed with the same key when the hold runs out, and the order it placed is shown", async () => {
    placeOrderAnswers = ["NETWORK_DOWN", { data: order("PENDING_PAYMENT") }];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");

    await advance(10 * 60_000);

    await screen.findByRole("region", { name: "Order status" });
    expect(screen.queryByText(/Your hold expired/)).toBeNull();
    const keys = placeOrderKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test("the replay at the deadline ends the hold when the server answers HOLD_EXPIRED", async () => {
    placeOrderAnswers = [
      "NETWORK_DOWN",
      {
        error: {
          code: "PRECONDITION_FAILED",
          httpStatus: 412,
          message: `HOLD_EXPIRED: ${HOLD_ID}`,
        },
      },
    ];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");

    await advance(10 * 60_000);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Your hold expired before your order was placed",
    );
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
    expect(placeOrderKeys()).toHaveLength(2);
  });

  test("a replay at the deadline that still gets no answer keeps the checkout for a manual retry with the same key", async () => {
    placeOrderAnswers = ["NETWORK_DOWN", "NETWORK_DOWN", { data: order("PENDING_PAYMENT") }];
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);
    await within(form).findByRole("alert");

    await advance(10 * 60_000);
    await advance(1_000);

    expect(screen.getByRole("region", { name: "Your hold" })).toBeTruthy();
    expect(placeOrderKeys()).toHaveLength(2);
    submit(screen.getByRole("form", { name: "Checkout" }));

    await screen.findByRole("region", { name: "Order status" });
    const keys = placeOrderKeys();
    expect(new Set(keys).size).toBe(1);
  });

  test("with no checkout submitted, the hold simply expires at the deadline", async () => {
    await holdingOneSeat();

    await advance(10 * 60_000);

    expect((await screen.findByRole("alert")).textContent).toContain("Your hold expired");
    expect(placeOrderKeys()).toHaveLength(0);
  });
});

describe("Order status", () => {
  test("a placed order replaces the hold and links to its status page", async () => {
    const form = await holdingOneSeat();
    fillContact(form, "alice@example.com");
    submit(form);

    const status = await screen.findByRole("region", { name: "Order status" });
    expect(screen.queryByRole("region", { name: "Your hold" })).toBeNull();
    expect(
      within(status)
        .getByRole("link", { name: /order status page/i })
        .getAttribute("href"),
    ).toBe(`/orders/${ORDER_ID}`);
  });

  test("polls getOrder every 2 s until a final state, then stops", async () => {
    getOrderAnswers = [
      { data: order("PENDING_PAYMENT") },
      { data: order("PENDING_PAYMENT") },
      { data: order("CONFIRMED") },
    ];
    renderWithApi(<OrderStatus orderId={ORDER_ID} />);

    const status = await screen.findByRole("region", { name: "Order status" });
    expect((await within(status).findByRole("status")).textContent).toContain(
      "Waiting for payment",
    );
    const polls = callsTo("booking.getOrder").length;

    await advance(2000);
    expect(callsTo("booking.getOrder")).toHaveLength(polls + 1);
    await advance(2000);
    expect(callsTo("booking.getOrder")).toHaveLength(polls + 2);
    expect(within(status).getByRole("status").textContent).toContain("confirmed");

    await advance(10_000);
    expect(callsTo("booking.getOrder")).toHaveLength(polls + 2);
  });

  test("a pending order shows the total and the payment deadline", async () => {
    renderWithApi(<OrderStatus orderId={ORDER_ID} />);

    const status = await screen.findByRole("region", { name: "Order status" });
    await within(status).findByRole("status");
    expect(status.textContent).toContain("€99.00");
    expect(status.textContent).toContain("1 ticket");
    expect(status.textContent).toContain("Mar 1, 2027");
  });

  test.each([
    {
      state: "CONFIRMED" as const,
      outcome: ["confirmed", "alice@example.com"],
      refund: "charged more than once",
    },
    {
      state: "CANCELLED" as const,
      outcome: ["cancelled", "payment failed"],
      refund: "refunded in full automatically",
    },
    {
      state: "EXPIRED" as const,
      outcome: ["expired", "deadline"],
      refund: "refunded in full automatically",
    },
  ])(
    "a $state order shows its outcome and refund information",
    async ({ state, outcome, refund }) => {
      getOrderAnswers = [{ data: order(state) }];
      renderWithApi(<OrderStatus orderId={ORDER_ID} />);

      const status = await screen.findByRole("region", { name: "Order status" });
      const text = (await within(status).findByRole("status")).textContent?.toLowerCase() ?? "";
      for (const part of outcome) {
        expect(text).toContain(part.toLowerCase());
      }
      expect(within(status).getByRole("note", { name: "Refunds" }).textContent).toContain(refund);
    },
  );

  test("a pending order shows no refund information yet", async () => {
    renderWithApi(<OrderStatus orderId={ORDER_ID} />);

    const status = await screen.findByRole("region", { name: "Order status" });
    await within(status).findByRole("status");
    expect(within(status).queryByRole("note", { name: "Refunds" })).toBeNull();
  });

  test("an unknown order says it was not found", async () => {
    getOrderAnswers = [
      { error: { code: "NOT_FOUND", httpStatus: 404, message: `Order ${ORDER_ID} not found` } },
    ];
    renderWithApi(<OrderStatus orderId={ORDER_ID} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Order not found");
  });
});
