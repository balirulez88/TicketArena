// Gathers the raw artifacts into one plain-data snapshot. Interpretation happens in state.ts, so
// it can be tested on literal fixtures; this module only knows where the harness keeps things.

import type { Gap, GitBranch } from "./model";
import type { Sources } from "./sources";
import { isTicketFileName } from "./tickets";

/** One Ralph run directory (`.ralph/logs/<run-id>/`, or one still inside a sandbox's `out/`). */
export interface RunFiles {
  runId: string;
  /** Where the directory was found: `logs`, or `sandbox <sandbox-run>` for a run still in it. */
  origin: string;
  runJson: string | null;
  sessionsTsv: string | null;
  sessionRecords: string[];
  decisions: { name: string; text: string }[];
  lastActivity: number | null;
}

export interface SandboxFiles {
  id: string;
  verdict: string | null;
  /** When the host wrote verdict.json (ms), or null while there is none. */
  decidedAt: number | null;
  lastActivity: number | null;
}

export interface Snapshot {
  takenAt: number;
  root: string;
  ref: string;
  commit: string | null;
  /** Ticket files at the ref (`issues/…` and `issues/done/…`); null when unreadable. */
  tickets: { path: string; text: string }[] | null;
  register: string | null;
  runs: RunFiles[];
  sandboxes: SandboxFiles[];
  hostReviews: { run: string; slug: string; text: string }[];
  batch: { state: string | null; lock: { owner: string | null } | null };
  pauses: { name: string; text: string }[];
  branches: GitBranch[];
  gaps: Gap[];
}

const REGISTER = "docs/technical-debt.md";
const RUN_ID = /^\d{8}-\d{6}$/;

const dirs = (sources: Sources, path: string): string[] =>
  (sources.list(path) ?? []).filter((entry) => entry.isDirectory).map((entry) => entry.name);
const files = (sources: Sources, path: string): string[] =>
  (sources.list(path) ?? []).filter((entry) => !entry.isDirectory).map((entry) => entry.name);

function readRun(sources: Sources, path: string, runId: string, origin: string): RunFiles {
  const names = files(sources, path);
  return {
    runId,
    origin,
    runJson: sources.read(`${path}/run.json`),
    sessionsTsv: sources.read(`${path}/sessions.tsv`),
    sessionRecords: files(sources, `${path}/sessions`)
      .filter((name) => name.endsWith(".tsv"))
      .sort()
      .map((name) => sources.read(`${path}/sessions/${name}`) ?? ""),
    decisions: names
      .filter((name) => /\.review-\d+\.decision\.json$/.test(name))
      .map((name) => ({ name, text: sources.read(`${path}/${name}`) ?? "" })),
    lastActivity: Math.max(
      sources.lastModified(path) ?? 0,
      sources.lastModified(`${path}/sessions`) ?? 0,
    ),
  };
}

function readTickets(sources: Sources, ref: string, gaps: Gap[]): Snapshot["tickets"] {
  try {
    const all = sources.filesAt(ref, "issues");
    return [...all.entries()]
      .filter(([path]) => /^issues\/(done\/)?[^/]+$/.test(path))
      .filter(([path]) => isTicketFileName(path.split("/").pop() ?? ""))
      .map(([path, text]) => ({ path, text }));
  } catch (error) {
    gaps.push({ source: `issues/ at ${ref}`, reason: messageOf(error) });
    return null;
  }
}

function readRegister(sources: Sources, ref: string, gaps: Gap[]): string | null {
  try {
    const text = sources.filesAt(ref, REGISTER).get(REGISTER);
    if (text === undefined) {
      gaps.push({ source: `${REGISTER} at ${ref}`, reason: "file does not exist at this ref" });
    }
    return text ?? null;
  } catch (error) {
    gaps.push({ source: `${REGISTER} at ${ref}`, reason: messageOf(error) });
    return null;
  }
}

function readBranches(sources: Sources, gaps: Gap[]): GitBranch[] {
  try {
    return [...sources.branches("rejected/"), ...sources.branches("ralph/paused/")];
  } catch (error) {
    gaps.push({ source: "git branches rejected/* and ralph/paused/*", reason: messageOf(error) });
    return [];
  }
}

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

export function takeSnapshot(
  sources: Sources,
  options: { root: string; ref: string; now: number },
): Snapshot {
  const { ref } = options;
  const gaps: Gap[] = [];
  const commit = sources.commitOf(ref);
  if (commit === null) {
    gaps.push({ source: `git ref ${ref}`, reason: "ref does not exist in the repository" });
  }
  if (sources.list(".ralph") === null) {
    gaps.push({
      source: ".ralph/",
      reason: "no run artifacts in this checkout (Ralph writes them only where it runs)",
    });
  }

  const runs = dirs(sources, ".ralph/logs")
    .filter((name) => RUN_ID.test(name))
    .map((name) => readRun(sources, `.ralph/logs/${name}`, name, "logs"));
  const sandboxes: SandboxFiles[] = [];
  for (const id of dirs(sources, ".ralph/sandbox")) {
    const base = `.ralph/sandbox/${id}`;
    sandboxes.push({
      id,
      verdict: sources.read(`${base}/verdict.json`),
      decidedAt: sources.lastModified(`${base}/verdict.json`),
      lastActivity: sources.lastModified(`${base}/out/logs`) ?? sources.lastModified(base),
    });
    // A run still inside a sandbox writes its logs to out/logs; the host copies them to
    // .ralph/logs only when it accepts or refuses the result.
    for (const runId of dirs(sources, `${base}/out/logs`).filter((name) => RUN_ID.test(name))) {
      if (!runs.some((run) => run.runId === runId)) {
        runs.push(readRun(sources, `${base}/out/logs/${runId}`, runId, `sandbox ${id}`));
      }
    }
  }

  const hostReviews = dirs(sources, ".ralph/host-review").flatMap((run) =>
    dirs(sources, `.ralph/host-review/${run}`).flatMap((slug) => {
      const text = sources.read(`.ralph/host-review/${run}/${slug}/decision.json`);
      return text === null ? [] : [{ run, slug, text }];
    }),
  );

  const lockPresent = sources.list(".ralph/batch/lock") !== null;
  return {
    takenAt: options.now,
    root: options.root,
    ref,
    commit,
    tickets: commit === null ? null : readTickets(sources, ref, gaps),
    register: commit === null ? null : readRegister(sources, ref, gaps),
    runs,
    sandboxes,
    hostReviews,
    batch: {
      state: sources.read(".ralph/batch/state.json"),
      lock: lockPresent ? { owner: sources.read(".ralph/batch/lock/owner.json") } : null,
    },
    pauses: files(sources, ".ralph/state")
      .filter((name) => name.endsWith(".pause"))
      .map((name) => ({ name, text: sources.read(`.ralph/state/${name}`) ?? "" })),
    branches: readBranches(sources, gaps),
    gaps,
  };
}
