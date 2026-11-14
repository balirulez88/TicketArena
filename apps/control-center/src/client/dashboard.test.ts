import { describe, expect, it } from "vitest";
import {
  ageText,
  type BoardFilter,
  cardMatches,
  columnVisible,
  shouldRefresh,
  viewFromHash,
} from "./dashboard";

const filter = (overrides: Partial<BoardFilter> = {}): BoardFilter => ({
  query: "",
  status: "open",
  eligibility: "any",
  ...overrides,
});

describe("view navigation", () => {
  it("selects the view named by the hash and falls back to the overview", () => {
    expect(viewFromHash("#board")).toBe("board");
    expect(viewFromHash("#runs")).toBe("runs");
    expect(viewFromHash("")).toBe("overview");
    expect(viewFromHash("#d-ticket-13")).toBe("overview");
  });
});

describe("board filters", () => {
  const card = { status: "ready-for-agent", eligibility: "eligible", search: "13 Release Hold" };

  it("hides only the done column by default", () => {
    expect(columnVisible("done", filter())).toBe(false);
    expect(columnVisible("blocked", filter())).toBe(true);
    expect(columnVisible("done", filter({ status: "all" }))).toBe(true);
    expect(columnVisible("blocked", filter({ status: "done" }))).toBe(false);
  });

  it("matches every search term case-insensitively", () => {
    expect(cardMatches(card, filter({ query: "release 13" }))).toBe(true);
    expect(cardMatches(card, filter({ query: "  HOLD " }))).toBe(true);
    expect(cardMatches(card, filter({ query: "release 14" }))).toBe(false);
  });

  it("filters on calculated eligibility and on the status column", () => {
    expect(cardMatches(card, filter({ eligibility: "eligible" }))).toBe(true);
    expect(cardMatches(card, filter({ eligibility: "waiting-debt" }))).toBe(false);
    expect(cardMatches(card, filter({ status: "blocked" }))).toBe(false);
    expect(cardMatches({ ...card, status: "done" }, filter())).toBe(false);
  });
});

describe("auto-refresh", () => {
  const context = { intervalSeconds: 30, paused: false, hidden: false, selecting: false };

  it("refreshes only when enabled, not paused, visible and no text is selected", () => {
    expect(shouldRefresh(context)).toBe(true);
    expect(shouldRefresh({ ...context, intervalSeconds: 0 })).toBe(false);
    expect(shouldRefresh({ ...context, paused: true })).toBe(false);
    expect(shouldRefresh({ ...context, hidden: true })).toBe(false);
    expect(shouldRefresh({ ...context, selecting: true })).toBe(false);
  });

  it("describes the data's age", () => {
    expect([4_000, 120_000, 3 * 3_600_000].map(ageText)).toEqual([
      "4s ago",
      "2 min ago",
      "3 h ago",
    ]);
  });
});
