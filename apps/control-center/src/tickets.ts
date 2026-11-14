import { type Completion, TICKET_STATUSES, type Ticket, type TicketLocation } from "./model";

const FILE_NAME = /^(\d{2})-[a-z0-9-]+\.md$/;

const fieldOf = (text: string, label: string): string | null => {
  const match = new RegExp(`^\\*\\*${label}:\\*\\* *(.*)$`, "m").exec(text);
  return match?.[1] === undefined ? null : match[1].replace(/\r$/, "").trim();
};

// Same reading as scripts/ralph-debt.mjs `parseTicket`, which Ralph's selection relies on:
// parenthesised titles may contain digits, so only bare two-digit numbers are references.
function blockersOf(value: string): string[] {
  if (value.startsWith("None")) {
    return [];
  }
  return value.replace(/\([^)]*\)/g, "").match(/\b\d{2}\b/g) ?? [];
}

// `**Completed:** <date> by slice/<NN>-<slug> (run <run-id>)`, added by the harness on merge.
function completionOf(value: string | null): Completion | null {
  const match = value === null ? null : /^(\S+) by (\S+) \(run ([^)]+)\)$/.exec(value);
  if (!match) {
    return null;
  }
  const [, date = "", branch = "", run = ""] = match;
  return { date, branch, run };
}

export const isTicketFileName = (name: string): boolean => FILE_NAME.test(name);

/**
 * Parses one ticket file under the contract in issues/README.md. A file that breaks the contract
 * still yields a ticket, with the violation in `problems`, so the page shows it rather than
 * silently dropping it.
 */
export function parseTicketFile(name: string, text: string, location: TicketLocation): Ticket {
  const slug = name.replace(/\.md$/, "");
  const number = slug.slice(0, 2);
  const problems: string[] = [];
  const titleMatch = /^# (\d{2}): (.+)$/m.exec(text);
  if (!titleMatch) {
    problems.push("missing title line `# NN: Title`");
  } else if (titleMatch[1] !== number) {
    problems.push(`title number ${titleMatch[1]} differs from file number ${number}`);
  }
  const status = fieldOf(text, "Status");
  if (status === null) {
    problems.push("missing `**Status:**` line");
  }
  const blocked = fieldOf(text, "Blocked by");
  if (blocked === null) {
    problems.push("missing `**Blocked by:**` line");
  }
  const completed = fieldOf(text, "Completed");
  const completion = completionOf(completed);
  if (completed !== null && completion === null) {
    problems.push("unrecognized `**Completed:**` line");
  }
  const statusText = status ?? "";
  return {
    number,
    slug,
    title: titleMatch?.[2]?.trim() ?? slug,
    status: statusText,
    statusRecognized: (TICKET_STATUSES as readonly string[]).includes(statusText),
    blockedBy: blockersOf(blocked ?? "None"),
    location,
    completion,
    criteria: {
      total: (text.match(/^- \[[ xX]\] /gm) ?? []).length,
      checked: (text.match(/^- \[[xX]\] /gm) ?? []).length,
    },
    problems,
  };
}
