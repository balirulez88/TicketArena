"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SeatStatus } from "./seat-map";

/** The buyer limit; the server enforces it again, this only keeps the UI honest. */
export const MAX_SELECTED_SEATS = 6;

export type SeatSelectionState = {
  readonly selectedSeatIds: readonly string[];
  /** True after an attempt to add a seat beyond the limit, until the selection shrinks. */
  readonly limitReached: boolean;
  toggleSeat(seat: { readonly id: string; readonly status: SeatStatus }): void;
  /** Empties the selection, e.g. once its seats are held. */
  clear(): void;
};

function createSeatSelectionStore(): StoreApi<SeatSelectionState> {
  return createStore<SeatSelectionState>()((set) => ({
    selectedSeatIds: [],
    limitReached: false,
    toggleSeat: (seat) =>
      set((state) => {
        if (state.selectedSeatIds.includes(seat.id)) {
          return {
            selectedSeatIds: state.selectedSeatIds.filter((id) => id !== seat.id),
            limitReached: false,
          };
        }
        if (seat.status !== "AVAILABLE") {
          return state;
        }
        if (state.selectedSeatIds.length >= MAX_SELECTED_SEATS) {
          return { ...state, limitReached: true };
        }
        return { selectedSeatIds: [...state.selectedSeatIds, seat.id], limitReached: false };
      }),
    clear: () => set({ selectedSeatIds: [], limitReached: false }),
  }));
}

const SeatSelectionContext = createContext<StoreApi<SeatSelectionState> | null>(null);

/**
 * Scopes one seat selection to a subtree (one event page). A provider-owned store, not a module
 * singleton, so server renders never share state between requests and a new event starts empty.
 */
export function SeatSelectionProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createSeatSelectionStore);
  return <SeatSelectionContext value={store}>{children}</SeatSelectionContext>;
}

export function useSeatSelection<T>(selector: (state: SeatSelectionState) => T): T {
  const store = useContext(SeatSelectionContext);
  if (store === null) {
    throw new Error("useSeatSelection must be used inside a SeatSelectionProvider");
  }
  return useStore(store, selector);
}
