import { describe, expect, it } from "vitest";
import { isTicketFileName, parseTicketFile } from "./tickets";

const ticketText = (lines: string[]) => lines.join("\n");

describe("parseTicketFile", () => {
  it("reads number, title, status, blockers and acceptance criteria", () => {
    const ticket = parseTicketFile(
      "14-hold-expiry.md",
      ticketText([
        "# 14: Hold expiry",
        "",
        "**What to build:** expire holds.",
        "",
        "**Blocked by:** 05 (release 2 holds), 07",
        "",
        "**Status:** ready-for-agent",
        "",
        "- [ ] first",
        "- [x] second",
        "- [ ] third",
      ]),
      "active",
    );
    expect(ticket).toMatchObject({
      number: "14",
      slug: "14-hold-expiry",
      title: "Hold expiry",
      status: "ready-for-agent",
      statusRecognized: true,
      // The digit inside the parenthesised title is not a reference (same as ralph-debt.mjs).
      blockedBy: ["05", "07"],
      location: "active",
      completion: null,
      criteria: { total: 3, checked: 1 },
      problems: [],
    });
  });

  it("reads the completion stamp of an archived ticket", () => {
    const ticket = parseTicketFile(
      "09-confirmation-notification.md",
      ticketText([
        "# 09: Confirmation notification",
        "**Blocked by:** None (can start immediately)",
        "**Status:** done",
        "**Completed:** 2026-11-05 by slice/09-confirmation-notification (run 20261105-075349)",
      ]),
      "done",
    );
    expect(ticket.blockedBy).toEqual([]);
    expect(ticket.location).toBe("done");
    expect(ticket.completion).toEqual({
      date: "2026-11-05",
      branch: "slice/09-confirmation-notification",
      run: "20261105-075349",
    });
  });

  it("keeps an unknown status verbatim and marks it unrecognized instead of mapping it", () => {
    const ticket = parseTicketFile(
      "20-refund-execution.md",
      ticketText(["# 20: Refund execution", "**Blocked by:** None", "**Status:** almost-done"]),
      "active",
    );
    expect(ticket.status).toBe("almost-done");
    expect(ticket.statusRecognized).toBe(false);
  });

  it("reports contract violations instead of dropping the ticket", () => {
    const ticket = parseTicketFile("21-refund-notifications.md", "# 22: Wrong number", "active");
    expect(ticket.status).toBe("");
    expect(ticket.statusRecognized).toBe(false);
    expect(ticket.problems).toEqual([
      "title number 22 differs from file number 21",
      "missing `**Status:**` line",
      "missing `**Blocked by:**` line",
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const ticket = parseTicketFile(
      "13-release-hold.md",
      "# 13: Release hold\r\n**Blocked by:** 04\r\n**Status:** blocked\r\n",
      "active",
    );
    expect(ticket).toMatchObject({ status: "blocked", blockedBy: ["04"], title: "Release hold" });
  });
});

describe("isTicketFileName", () => {
  it("accepts NN-kebab-slug.md only", () => {
    expect(isTicketFileName("12-lock-timeout.md")).toBe(true);
    expect(isTicketFileName("README.md")).toBe(false);
    expect(isTicketFileName("1-short.md")).toBe(false);
  });
});
