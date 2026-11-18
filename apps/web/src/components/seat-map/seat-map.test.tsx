// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { SeatMap, type SeatMapSeat } from "./seat-map";
import { SeatSelectionProvider } from "./seat-selection";

afterEach(cleanup);

let nextId = 0;
function seat(overrides: Partial<SeatMapSeat> & Pick<SeatMapSeat, "row" | "number">): SeatMapSeat {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    section: "Floor",
    status: "AVAILABLE",
    priceMinor: 4500,
    currency: "EUR",
    ...overrides,
  };
}

function renderSeatMap(seats: readonly SeatMapSeat[]) {
  render(
    <SeatSelectionProvider>
      <SeatMap seats={seats} />
    </SeatSelectionProvider>,
  );
}

function seatButton(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("SeatMap accessible names", () => {
  test("each seat is a native button named by section, row, number, price and status", () => {
    renderSeatMap([
      seat({ row: "A", number: 1 }),
      seat({ row: "A", number: 2, status: "HELD" }),
      seat({ row: "B", number: 1, status: "IN_CHECKOUT" }),
      seat({ section: "Balcony", row: "C", number: 7, status: "SOLD", priceMinor: 2550 }),
    ]);

    const buttons = [
      seatButton("Section Floor, row A, seat 1, €45.00, available"),
      seatButton("Section Floor, row A, seat 2, €45.00, held"),
      seatButton("Section Floor, row B, seat 1, €45.00, in checkout"),
      seatButton("Section Balcony, row C, seat 7, €25.50, sold"),
    ];
    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  test("each section is a labelled group", () => {
    renderSeatMap([
      seat({ row: "A", number: 1 }),
      seat({ section: "Balcony", row: "A", number: 1 }),
    ]);

    expect(screen.getByRole("group", { name: "Section Floor" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Section Balcony" })).toBeTruthy();
  });

  test("seats that cannot be selected stay focusable but are marked disabled", () => {
    renderSeatMap([seat({ row: "A", number: 1, status: "SOLD" })]);

    const sold = seatButton("Section Floor, row A, seat 1, €45.00, sold");
    expect(sold.getAttribute("aria-disabled")).toBe("true");
    expect(sold.hasAttribute("disabled")).toBe(false);
  });
});

describe("SeatMap selection rules", () => {
  test("activating an available seat selects it and activating it again deselects it", async () => {
    const user = userEvent.setup();
    renderSeatMap([seat({ row: "A", number: 1 })]);
    const button = seatButton("Section Floor, row A, seat 1, €45.00, available");

    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("1 of 6 seats selected");

    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("status").textContent).toContain("0 of 6 seats selected");
  });

  test("held, in-checkout and sold seats cannot be selected", async () => {
    const user = userEvent.setup();
    renderSeatMap([
      seat({ row: "A", number: 1, status: "HELD" }),
      seat({ row: "A", number: 2, status: "IN_CHECKOUT" }),
      seat({ row: "A", number: 3, status: "SOLD" }),
    ]);

    for (const button of screen.getAllByRole("button")) {
      await user.click(button);
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
    expect(screen.getByRole("status").textContent).toContain("0 of 6 seats selected");
  });

  test("at most 6 seats can be selected, and the limit is announced", async () => {
    const user = userEvent.setup();
    renderSeatMap(Array.from({ length: 7 }, (_, index) => seat({ row: "A", number: index + 1 })));
    const buttons = screen.getAllByRole("button");

    for (const button of buttons) {
      await user.click(button);
    }

    const pressed = buttons.filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(6);
    expect(buttons[6]?.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("status").textContent).toContain("6 of 6 seats selected");
    expect(screen.getByRole("status").textContent).toContain("You can select up to 6 seats.");
  });

  test("deselecting a seat at the limit frees room for another one", async () => {
    const user = userEvent.setup();
    renderSeatMap(Array.from({ length: 7 }, (_, index) => seat({ row: "A", number: index + 1 })));
    const buttons = screen.getAllByRole("button");
    for (const button of buttons.slice(0, 6)) {
      await user.click(button);
    }

    const [first] = buttons;
    const seventh = buttons[6];
    if (first === undefined || seventh === undefined) {
      throw new Error("expected seven seats");
    }
    await user.click(first);
    await user.click(seventh);

    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(seventh.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).not.toContain("You can select up to 6 seats.");
  });

  test("each provider holds its own selection", async () => {
    const user = userEvent.setup();
    renderSeatMap([seat({ row: "A", number: 1 })]);
    await user.click(seatButton("Section Floor, row A, seat 1, €45.00, available"));
    cleanup();

    renderSeatMap([seat({ row: "A", number: 1 })]);

    expect(
      seatButton("Section Floor, row A, seat 1, €45.00, available").getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("SeatMap keyboard", () => {
  test("Tab reaches a seat and Enter or Space toggles it", async () => {
    const user = userEvent.setup();
    renderSeatMap([seat({ row: "A", number: 1 })]);
    const button = seatButton("Section Floor, row A, seat 1, €45.00, available");

    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard("{Enter}");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard(" ");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("arrow keys move focus between neighbouring seats of a section", async () => {
    const user = userEvent.setup();
    renderSeatMap([
      seat({ row: "A", number: 1 }),
      seat({ row: "A", number: 2, status: "SOLD" }),
      seat({ row: "B", number: 1 }),
      seat({ row: "B", number: 2 }),
    ]);

    seatButton("Section Floor, row A, seat 1, €45.00, available").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(seatButton("Section Floor, row A, seat 2, €45.00, sold"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      seatButton("Section Floor, row B, seat 2, €45.00, available"),
    );
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(
      seatButton("Section Floor, row B, seat 1, €45.00, available"),
    );
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      seatButton("Section Floor, row A, seat 1, €45.00, available"),
    );
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(
      seatButton("Section Floor, row A, seat 1, €45.00, available"),
    );
  });
});
