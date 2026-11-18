// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppRouter } from "@/server/routers/_app";
import type { AdminSnapshot } from "@/server/routers/admin";
import { TRPCProvider } from "@/trpc/react";
import { AdminDashboard } from "./admin-dashboard";
import { AdminLoginForm } from "./admin-login-form";

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
          limit_exceeded: 0,
        },
      },
    ],
  };
}

let snapshotCalls = 0;
let unauthorized = false;

/** Answers `admin.snapshot` the way the API route does; the network is the faked boundary. */
async function fakeApi(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname !== "/api/trpc/admin.snapshot") {
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
    ).toEqual(["Demo Race", "90", "4", "3", "7", "42", "5", "1", "6", "2", "1", "0"]);

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

describe("AdminLoginForm", () => {
  test("posts the password to the login route", () => {
    render(<AdminLoginForm failed={false} />);

    const password = screen.getByLabelText("Admin password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("name")).toBe("password");
    const form = password.closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/admin/login");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a failed attempt says the password was wrong", () => {
    render(<AdminLoginForm failed={true} />);

    expect(screen.getByRole("alert").textContent).toContain("Wrong password");
  });
});
