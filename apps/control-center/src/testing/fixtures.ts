// Literal artifacts in the formats the harness writes, for tests of the mapping.

import type { RunFiles, Snapshot } from "../snapshot";

export const NOW = Date.parse("2026-11-13T12:00:00Z");
export const MINUTE = 60_000;

export function ticket(
  number: string,
  slug: string,
  status: string,
  blockedBy: string[] = [],
): { path: string; text: string } {
  const folder = status === "done" ? "issues/done" : "issues";
  return {
    path: `${folder}/${number}-${slug}.md`,
    text: [
      `# ${number}: ${slug.replace(/-/g, " ")}`,
      "",
      `**Blocked by:** ${blockedBy.length === 0 ? "None (can start immediately)" : blockedBy.join(", ")}`,
      "",
      `**Status:** ${status}`,
      "",
      "- [ ] it works",
    ].join("\n"),
  };
}

export function debtEntry(id: string, fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([name, value]) => `- **${name}:** ${value}`);
  return [`### ${id}: ${id} title`, "", ...lines, ""].join("\n");
}

export const register = (...entries: string[]): string =>
  [
    "# Technical Debt Register",
    "",
    "<!-- ralph-debt:begin -->",
    "",
    ...entries,
    "<!-- ralph-debt:end -->",
    "",
  ].join("\n");

export const triagedLow = (blocks: string, target: string): Record<string, string> => ({
  Status: "PLANNED",
  Severity: "LOW",
  Risk: "CORRECTNESS",
  Triage: "2026-11-01: maintainer, in review",
  Source: "ticket 01 (`01-x`)",
  Target: target,
  Blocks: blocks,
});

export const sessionLine = (
  started: string,
  label: string,
  status: string,
  finished = "-",
  exit = status === "running" ? "-" : status === "ok" ? "0" : "1",
): string =>
  [started, label, `sess-${label.replace(/\W/g, "")}`, status, exit, finished].join("\t");

export const SESSIONS_HEADER = "started\tlabel\tsession\tstatus\texit\tfinished";

export function run(runId: string, overrides: Partial<RunFiles> = {}): RunFiles {
  return {
    runId,
    origin: "logs",
    runJson: JSON.stringify({
      run_id: runId,
      status: "succeeded",
      started_at: null,
      finished_at: null,
    }),
    sessionsTsv: null,
    sessionRecords: [],
    decisions: [],
    lastActivity: NOW - 600 * MINUTE,
    ...overrides,
  };
}

export const runJson = (runId: string, status: string, finishedAt: string | null = null) =>
  JSON.stringify({ run_id: runId, status, started_at: null, finished_at: finishedAt });

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    takenAt: NOW,
    root: "/repo",
    ref: "main",
    commit: "a3bb37f319bb54e2964157cd2df0700bbfbf4cd5",
    tickets: [],
    register: register(),
    runs: [],
    sandboxes: [],
    hostReviews: [],
    batch: { state: null, lock: null },
    pauses: [],
    branches: [],
    gaps: [],
    ...overrides,
  };
}
