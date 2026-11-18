"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { type KeyboardEvent, useRef } from "react";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppRouter } from "@/server/routers/_app";
import { MAX_SELECTED_SEATS, useSeatSelection } from "./seat-selection";

export type SeatMapSeat = inferRouterOutputs<AppRouter>["seats"]["map"]["seats"][number];
export type SeatStatus = SeatMapSeat["status"];

const STATUS_LABEL: Record<SeatStatus, string> = {
  AVAILABLE: "available",
  HELD: "held",
  IN_CHECKOUT: "in checkout",
  SOLD: "sold",
};

type SectionLayout = {
  readonly name: string;
  readonly rows: readonly (readonly SeatMapSeat[])[];
  readonly maxNumber: number;
};

/** Groups seats into sections and rows, keeping the server's order (section, row, number). */
function layoutSections(seats: readonly SeatMapSeat[]): SectionLayout[] {
  const sections = new Map<string, Map<string, SeatMapSeat[]>>();
  for (const seat of seats) {
    const rows = sections.get(seat.section) ?? new Map<string, SeatMapSeat[]>();
    sections.set(seat.section, rows);
    const row = rows.get(seat.row) ?? [];
    rows.set(seat.row, row);
    row.push(seat);
  }
  return [...sections].map(([name, rows]) => {
    const sortedRows = [...rows.values()].map((row) =>
      [...row].sort((a, b) => a.number - b.number),
    );
    const maxNumber = Math.max(...sortedRows.flatMap((row) => row.map((seat) => seat.number)));
    return { name, rows: sortedRows, maxNumber };
  });
}

function seatLabel(seat: SeatMapSeat): string {
  const price = formatPrice(seat.priceMinor, seat.currency);
  return `Section ${seat.section}, row ${seat.row}, seat ${seat.number}, ${price}, ${STATUS_LABEL[seat.status]}`;
}

function nearestByNumber(row: readonly SeatMapSeat[], number: number): SeatMapSeat | undefined {
  let nearest: SeatMapSeat | undefined;
  for (const seat of row) {
    if (
      nearest === undefined ||
      Math.abs(seat.number - number) < Math.abs(nearest.number - number)
    ) {
      nearest = seat;
    }
  }
  return nearest;
}

/** The seat an arrow key moves to from `rowIndex`/`seatIndex`; undefined at an edge. */
function neighbour(
  section: SectionLayout,
  rowIndex: number,
  seatIndex: number,
  key: string,
): SeatMapSeat | undefined {
  const row = section.rows[rowIndex] ?? [];
  const current = row[seatIndex];
  if (current === undefined) {
    return undefined;
  }
  switch (key) {
    case "ArrowLeft":
      return row[seatIndex - 1];
    case "ArrowRight":
      return row[seatIndex + 1];
    case "ArrowUp":
      return nearestByNumber(section.rows[rowIndex - 1] ?? [], current.number);
    case "ArrowDown":
      return nearestByNumber(section.rows[rowIndex + 1] ?? [], current.number);
    default:
      return undefined;
  }
}

function seatClassName(status: SeatStatus, selected: boolean): string {
  return cn(
    "flex size-8 items-center justify-center rounded-md border text-xs outline-none transition-colors",
    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
    status === "AVAILABLE" && "border-input bg-background hover:bg-accent",
    status !== "AVAILABLE" &&
      "cursor-not-allowed border-transparent bg-muted text-muted-foreground",
    selected && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
  );
}

/**
 * The event's seats as CSS grids of native buttons: one grid area per section, one grid row per
 * seat row. Arrow keys move focus within a section; Tab, Enter and Space work as for any button.
 */
export function SeatMap({ seats }: { readonly seats: readonly SeatMapSeat[] }) {
  const sections = layoutSections(seats);
  const selectedSeatIds = useSeatSelection((state) => state.selectedSeatIds);
  const limitReached = useSeatSelection((state) => state.limitReached);
  const toggleSeat = useSeatSelection((state) => state.toggleSeat);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  function moveFocus(
    event: KeyboardEvent<HTMLButtonElement>,
    section: SectionLayout,
    rowIndex: number,
    seatIndex: number,
  ) {
    const target = neighbour(section, rowIndex, seatIndex, event.key);
    if (event.key.startsWith("Arrow")) {
      // Arrows would otherwise scroll the page while focus stays put.
      event.preventDefault();
    }
    if (target !== undefined) {
      buttons.current.get(target.id)?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-muted-foreground text-sm">
        {selectedSeatIds.length} of {MAX_SELECTED_SEATS} seats selected.
        {limitReached && ` You can select up to ${MAX_SELECTED_SEATS} seats.`}
      </p>
      <div
        className="grid gap-6"
        style={{ gridTemplateAreas: sections.map((_, index) => `"s${index}"`).join(" ") }}
      >
        {sections.map((section, sectionIndex) => (
          <fieldset
            key={section.name}
            className="flex min-w-0 flex-col gap-2 overflow-x-auto"
            style={{ gridArea: `s${sectionIndex}` }}
          >
            <legend className="font-medium">Section {section.name}</legend>
            <div
              className="grid w-max gap-1"
              style={{ gridTemplateColumns: `auto repeat(${section.maxNumber}, 2rem)` }}
            >
              {section.rows.map((row, rowIndex) => [
                <span
                  key={`label-${row[0]?.row}`}
                  aria-hidden="true"
                  className="self-center pr-2 text-muted-foreground text-xs"
                  style={{ gridRow: rowIndex + 1, gridColumn: 1 }}
                >
                  {row[0]?.row}
                </span>,
                ...row.map((seat, seatIndex) => {
                  const selected = selectedSeatIds.includes(seat.id);
                  return (
                    <button
                      key={seat.id}
                      ref={(element) => {
                        if (element === null) {
                          buttons.current.delete(seat.id);
                        } else {
                          buttons.current.set(seat.id, element);
                        }
                      }}
                      type="button"
                      aria-label={seatLabel(seat)}
                      aria-pressed={selected}
                      aria-disabled={seat.status !== "AVAILABLE" && !selected}
                      className={seatClassName(seat.status, selected)}
                      style={{ gridRow: rowIndex + 1, gridColumn: seat.number + 1 }}
                      onClick={() => toggleSeat(seat)}
                      onKeyDown={(event) => moveFocus(event, section, rowIndex, seatIndex)}
                    >
                      {seat.number}
                    </button>
                  );
                }),
              ])}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
