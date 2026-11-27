// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppRouter } from "@/server/routers/_app";
import type {
  AdminFeedPage,
  AdminSnapshot,
  RaceResult,
  ResetDemoResult,
  StuckRefund,
} from "@/server/routers/admin";
import { TRPCProvider } from "@/trpc/react";
import { AdminDashboard } from "./admin-dashboard";
import { AdminLoginForm, loginFailureFrom } from "./admin-login-form";
import { AdminLogoutButton } from "./admin-logout-button";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function snapshotWith(holdOk: number): AdminSnapshot {
  return {
    takenAt: new Date("2027-03-01T12:00:00.000Z"),
    orders: { PENDING_PAYMENT: 3, CONFIRMED: 7, CANCELLED: 1, EXPIRED: 2 },
    pendingPayments: 3,
    events: [
      {
        eventId: EVENT_ID,
        name: "Demo Race",
        demo: true,
        seats: { AVAILABLE: 90, HELD: 4, IN_CHECKOUT: 3, SOLD: 7 },
        queueLength: 42,
        activeShoppers: 5,
        metrics: {
          hold_ok: holdOk,
          seat_unavailable: 6,
          race_lost: 2,
          booking_busy: 1,
          deadlock_retry: 8,
          limit_exceeded: 0,
          late_delivery_refund: 9,
        },
      },
    ],
    messageHealth: {
      outboxLagMs: { booking: 1500, payment: 0, notification: 250 },
      delivery: deliveryFigures,
    },
    refundPendingAgeMaxMs: 125_000,
  };
}

let deliveryFigures: AdminSnapshot["messageHealth"]["delivery"] = null;

const SAGA = "55555555-5555-4555-8555-555555555555";
const OTHER_SAGA = "66666666-6666-4666-8666-666666666666";

function feedEntry(
  n: number,
  eventType: string,
  correlationId: string,
  status: "PENDING" | "PUBLISHED" | "FAILED" = "PUBLISHED",
): AdminFeedPage["entries"][number] {
  const id = `00000000-0000-4000-8000-00000000000${n}`;
  return {
    id,
    service: eventType.startsWith("payment") ? "payment" : "booking",
    eventType,
    aggregateType: "order",
    aggregateId: id,
    correlationId,
    status,
    createdAt: new Date(`2027-03-01T12:00:0${n}.000Z`),
    publishedAt: null,
  };
}

const FEED_PAGE: AdminFeedPage = {
  entries: [
    feedEntry(1, "seat.held", SAGA),
    feedEntry(2, "seat.held", OTHER_SAGA),
    feedEntry(3, "order.placed", SAGA),
    feedEntry(4, "payment.succeeded", SAGA, "FAILED"),
  ],
  nextCursor: {
    createdAt: new Date("2027-03-01T12:00:04.000Z"),
    id: "00000000-0000-4000-8000-000000000004",
  },
};

const STUCK_PAYMENT = "77777777-7777-4777-8777-777777777777";
const PENDING_PAYMENT = "88888888-8888-4888-8888-888888888888";

const STUCK_REFUNDS: StuckRefund[] = [
  {
    paymentId: STUCK_PAYMENT,
    orderId: "99999999-9999-4999-8999-999999999999",
    amount: 4200,
    currency: "EUR",
    status: "MANUAL_REVIEW",
    refundAttempts: 3,
    refundRequestedAt: new Date("2027-03-01T11:00:00.000Z"),
    refundLastRequestedAt: new Date("2027-03-01T11:30:00.000Z"),
    orphan: false,
    ageMs: 3_600_000,
  },
  {
    paymentId: PENDING_PAYMENT,
    orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    amount: 1000,
    currency: "EUR",
    status: "REFUND_REQUESTED",
    refundAttempts: 1,
    refundRequestedAt: new Date("2027-03-01T11:45:00.000Z"),
    refundLastRequestedAt: new Date("2027-03-01T11:55:00.000Z"),
    orphan: true,
    ageMs: 900_000,
  },
];

const feedInputs: unknown[] = [];
const retryInputs: unknown[] = [];

const RACE: RaceResult = {
  eventId: EVENT_ID,
  seatId: "22222222-2222-4222-8222-222222222222",
  buyers: 100,
  successes: 1,
  seatUnavailable: 97,
  bookingBusy: 2,
  otherErrors: 0,
  durationMs: 42,
  winner: {
    holdId: "33333333-3333-4333-8333-333333333333",
    correlationId: "44444444-4444-4444-8444-444444444444",
  },
};

const RESET: ResetDemoResult = {
  eventId: EVENT_ID,
  holdsDeleted: 2,
  ordersKept: 1,
  seatsFreed: 3,
};

let snapshotCalls = 0;
let unauthorized = false;
let rateLimited = false;
const actionCalls: string[] = [];

function trpcError(message: string, code: string, httpStatus: number): Response {
  const error = { message, code: -32029, data: { code, httpStatus } };
  return Response.json({ error: superjson.serialize(error) }, { status: httpStatus });
}

async function requestBody(
  input: RequestInfo | URL,
  init?: { readonly body?: unknown },
): Promise<string> {
  if (input instanceof Request) {
    return input.text();
  }
  return typeof init?.body === "string" ? init.body : "";
}

const ok = (data: unknown) => Response.json({ result: { data: superjson.serialize(data) } });

/** The feed and refund procedures; `undefined` for any other path. */
async function fakeFeedAndRefunds(
  action: string,
  url: URL,
  input: RequestInfo | URL,
  init?: { readonly body?: unknown },
): Promise<Response | undefined> {
  if (action === "admin.feed") {
    const raw = url.searchParams.get("input");
    feedInputs.push(raw === null ? undefined : superjson.parse(raw));
    // Only the first poll finds entries; later polls after its cursor find nothing new.
    return ok(
      feedInputs.length === 1 ? FEED_PAGE : { entries: [], nextCursor: FEED_PAGE.nextCursor },
    );
  }
  if (action === "admin.stuckRefunds") {
    return ok(STUCK_REFUNDS);
  }
  if (action === "admin.retryRefund") {
    retryInputs.push(superjson.parse(await requestBody(input, init)));
    return ok({ ...STUCK_REFUNDS[0], status: "REFUND_REQUESTED", refundAttempts: 0 });
  }
  return undefined;
}

/** Answers the admin procedures the way the API route does; the network is the faked boundary. */
async function fakeApi(
  input: RequestInfo | URL,
  init?: { readonly body?: unknown },
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const action = url.pathname.replace("/api/trpc/", "");
  if (action === "admin.runRace" || action === "admin.resetDemo") {
    actionCalls.push(action);
    if (rateLimited) {
      return trpcError(
        `${action} is limited to 1 per 10 s; retry in 7 s`,
        "TOO_MANY_REQUESTS",
        429,
      );
    }
    const data = action === "admin.runRace" ? RACE : RESET;
    return Response.json({ result: { data: superjson.serialize(data) } });
  }
  const answered = await fakeFeedAndRefunds(action, url, input, init);
  if (answered !== undefined) {
    return answered;
  }
  if (action !== "admin.snapshot") {
    return Response.json({}, { status: 404 });
  }
  if (unauthorized) {
    const error = {
      message: "Admin login required",
      code: -32001,
      data: { code: "UNAUTHORIZED", httpStatus: 401 },
    };
    return Response.json({ error: superjson.serialize(error) }, { status: 401 });
  }
  snapshotCalls += 1;
  // Each poll sees one more successful hold, so a refresh is visible on screen.
  return Response.json({ result: { data: superjson.serialize(snapshotWith(snapshotCalls)) } });
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
  snapshotCalls = 0;
  unauthorized = false;
  rateLimited = false;
  actionCalls.length = 0;
  feedInputs.length = 0;
  retryInputs.length = 0;
  deliveryFigures = null;
  // Time is the faked boundary; it still advances on its own so Testing Library can wait.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const holdOkCell = () => {
  const row = screen.getByRole("row", { name: /Demo Race/ });
  return within(row).getByTestId("metric-hold_ok").textContent;
};

describe("AdminDashboard", () => {
  test("shows seats, orders, pending payments, queue and booking-metric figures", async () => {
    renderWithApi(<AdminDashboard />);

    const seats = await screen.findByRole("table", { name: "Seats, queue and metrics per event" });
    const row = within(seats).getByRole("row", { name: /Demo Race/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Demo Race", "90", "4", "3", "7", "42", "5", "1", "6", "2", "1", "8", "0", "9"]);

    const orders = screen.getByRole("table", { name: "Orders by status" });
    expect(orders.textContent).toContain("Pending payment3");
    expect(orders.textContent).toContain("Confirmed7");
    expect(orders.textContent).toContain("Cancelled1");
    expect(orders.textContent).toContain("Expired2");
    expect(screen.getByText("Pending payments").parentElement?.textContent).toContain("3");
  });

  test("polls the snapshot every second", async () => {
    renderWithApi(<AdminDashboard />);
    await screen.findByRole("row", { name: /Demo Race/ });
    expect(holdOkCell()).toBe("1");
    const afterFirstLoad = snapshotCalls;

    await vi.advanceTimersByTimeAsync(1000);

    expect(snapshotCalls).toBe(afterFirstLoad + 1);
    expect(holdOkCell()).toBe("2");

    await vi.advanceTimersByTimeAsync(1000);

    expect(snapshotCalls).toBe(afterFirstLoad + 2);
    expect(holdOkCell()).toBe("3");
  });

  test("an expired admin session asks the operator to log in again", async () => {
    unauthorized = true;
    renderWithApi(<AdminDashboard />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your admin session has ended");
    expect(within(alert).getByRole("link", { name: "Log in" }).getAttribute("href")).toBe(
      "/admin/login",
    );
  });
});

describe("AdminDashboard message health", () => {
  test("shows outbox lag per service, consumer figures, the DLQ and the oldest open refund", async () => {
    deliveryFigures = {
      consumers: {
        payment: { lag: 4, pendingAcks: 2, redeliveries: 1 },
        notification: null,
      },
      dlq: { size: 3, oldestAgeMs: 90_000 },
    };
    renderWithApi(<AdminDashboard />);

    const outbox = await screen.findByRole("table", { name: "Outbox lag per service" });
    expect(within(outbox).getByRole("row", { name: /booking/ }).textContent).toContain("1.5 s");
    expect(within(outbox).getByRole("row", { name: /notification/ }).textContent).toContain(
      "0.3 s",
    );
    const consumers = screen.getByRole("table", { name: "Consumer delivery" });
    expect(
      within(within(consumers).getByRole("row", { name: /payment/ }))
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["payment", "4", "2", "1"]);
    expect(within(consumers).getByRole("row", { name: /notification/ }).textContent).toContain(
      "not found",
    );
    const health = screen.getByRole("region", { name: "Message health" });
    expect(within(health).getByText("DLQ size").parentElement?.textContent).toContain("3");
    expect(within(health).getByText("Oldest DLQ message").parentElement?.textContent).toContain(
      "1 min 30 s",
    );
    expect(within(health).getByText("Oldest open refund").parentElement?.textContent).toContain(
      "2 min 5 s",
    );
  });

  test("says the NATS figures are unavailable when the worker cannot be read", async () => {
    renderWithApi(<AdminDashboard />);

    const health = await screen.findByRole("region", { name: "Message health" });
    expect(health.textContent).toContain("Consumer and DLQ figures are unavailable");
    expect(within(health).getByRole("table", { name: "Outbox lag per service" })).toBeTruthy();
  });
});

const eventTypesOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1]?.textContent);

describe("AdminDashboard live feed", () => {
  test("shows each outbox entry with its service, status and correlation id, and polls after its cursor", async () => {
    renderWithApi(<AdminDashboard />);

    const feed = await screen.findByRole("table", { name: "Live event feed" });
    await within(feed).findByRole("row", { name: /payment\.succeeded/ });
    expect(eventTypesOf(feed)).toEqual([
      "seat.held",
      "seat.held",
      "order.placed",
      "payment.succeeded",
    ]);
    const last = within(feed).getByRole("row", { name: /payment\.succeeded/ });
    expect(last.textContent).toContain("FAILED");
    expect(last.textContent).toContain("payment");
    expect(last.textContent).toContain(SAGA);

    await vi.advanceTimersByTimeAsync(1000);

    expect(feedInputs.at(-1)).toMatchObject({ cursor: FEED_PAGE.nextCursor });
    // Entries already shown stay.
    expect(eventTypesOf(feed)).toHaveLength(4);
  });

  test("groups the entries by correlation id on request", async () => {
    renderWithApi(<AdminDashboard />);
    await screen.findByRole("row", { name: /payment\.succeeded/ });

    fireEvent.click(screen.getByRole("checkbox", { name: "Group by correlation id" }));

    expect(eventTypesOf(screen.getByRole("table", { name: `Saga ${SAGA}` }))).toEqual([
      "seat.held",
      "order.placed",
      "payment.succeeded",
    ]);
    expect(eventTypesOf(screen.getByRole("table", { name: `Saga ${OTHER_SAGA}` }))).toEqual([
      "seat.held",
    ]);
  });
});

describe("AdminDashboard stuck refunds", () => {
  test("lists open refund obligations with their age, and retries one in manual review", async () => {
    renderWithApi(<AdminDashboard />);

    const table = await screen.findByRole("table", { name: "Stuck refunds" });
    const stuck = await within(table).findByRole("row", { name: new RegExp(STUCK_PAYMENT) });
    expect(stuck.textContent).toContain("MANUAL_REVIEW");
    expect(stuck.textContent).toContain("1 h 0 min");
    const pending = within(table).getByRole("row", { name: new RegExp(PENDING_PAYMENT) });
    expect(pending.textContent).toContain("REFUND_REQUESTED");
    expect(pending.textContent).toContain("15 min 0 s");
    // Only a refund in manual review can be retried.
    expect(within(pending).queryByRole("button")).toBeNull();

    fireEvent.click(within(stuck).getByRole("button", { name: `Retry refund ${STUCK_PAYMENT}` }));

    const result = await screen.findByRole("status", { name: "Refund retry result" });
    expect(retryInputs).toEqual([{ paymentId: STUCK_PAYMENT }]);
    expect(result.textContent).toContain(STUCK_PAYMENT);
  });
});

describe("AdminDashboard demo actions", () => {
  test("Run race shows the race's successes, refusals and duration", async () => {
    renderWithApi(<AdminDashboard />);

    fireEvent.click(await screen.findByRole("button", { name: "Run race" }));

    const result = await screen.findByRole("status", { name: "Race result" });
    expect(actionCalls).toEqual(["admin.runRace"]);
    expect(result.textContent).toContain("1 success");
    expect(result.textContent).toContain("97 seat unavailable");
    expect(result.textContent).toContain("2 booking busy");
    expect(result.textContent).toContain("42 ms");
    expect(result.textContent).toContain(RACE.winner?.correlationId);
  });

  test("Reset demo shows what was cleared and what was kept", async () => {
    renderWithApi(<AdminDashboard />);

    fireEvent.click(await screen.findByRole("button", { name: "Reset demo" }));

    const result = await screen.findByRole("status", { name: "Reset result" });
    expect(actionCalls).toEqual(["admin.resetDemo"]);
    expect(result.textContent).toContain("2 holds deleted");
    expect(result.textContent).toContain("1 order kept");
    expect(result.textContent).toContain("3 seats freed");
  });

  test("a rate-limited action says when to retry", async () => {
    rateLimited = true;
    renderWithApi(<AdminDashboard />);

    fireEvent.click(await screen.findByRole("button", { name: "Run race" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("retry in 7 s");
  });
});

describe("AdminLoginForm", () => {
  test("posts the password to the login route", () => {
    render(<AdminLoginForm failure={null} />);

    const password = screen.getByLabelText("Admin password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("name")).toBe("password");
    const form = password.closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/admin/login");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a failed attempt says the password was wrong", () => {
    render(<AdminLoginForm failure={loginFailureFrom({ error: "invalid" })} />);

    expect(screen.getByRole("alert").textContent).toContain("Wrong password");
  });

  test("a rate-limited attempt says how many seconds to wait", () => {
    render(<AdminLoginForm failure={loginFailureFrom({ error: "rate-limited", retry: "7" })} />);

    expect(screen.getByRole("alert").textContent).toContain("Try again in 7 s");
  });

  test("an attempt refused for an unavailable limiter says login is unavailable", () => {
    render(<AdminLoginForm failure={loginFailureFrom({ error: "unavailable" })} />);

    expect(screen.getByRole("alert").textContent).toContain("Login is unavailable");
  });

  test("unknown or malformed query parameters show no error", () => {
    expect(loginFailureFrom({})).toBeNull();
    expect(loginFailureFrom({ error: "other" })).toBeNull();
    expect(loginFailureFrom({ error: "rate-limited", retry: "soon" })).toEqual({
      kind: "rate-limited",
      retrySeconds: null,
    });
  });
});

describe("AdminLogoutButton", () => {
  test("posts to the logout route", () => {
    render(<AdminLogoutButton />);

    const button = screen.getByRole("button", { name: "Log out" });
    const form = button.closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/admin/logout");
  });
});
