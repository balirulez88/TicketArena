// Gathers the raw artifacts into one plain-data snapshot. Interpretation happens in state.ts, so
// it can be tested on literal fixtures; this module only knows where the harness keeps things.
//
// It keeps apart three outcomes that a plain `null` would merge: a file that does not exist (often
// meaningful: no verdict yet, run still in progress), a file that exists but could not be read,
// and a directory that could not be listed. The last two make what is below them unknown, never
// empty.

import type { Gap, GitBranch } from "./model";
import type { DirEntry, Sources } from "./sources";
import { isTicketFileName } from "./tickets";

/** A file's text; `null` when it does not exist; or why it exists but could not be read. */
export type FileText = string | null | { unreadable: string };

/** One Ralph run directory (`.ralph/logs/<run-id>/`, or one still inside a sandbox's `out/`). */
export interface RunFiles {
  runId: string;
  /** Where the directory was found: `logs`, or `sandbox <sandbox-run>` for a run still in it. */
  origin: string;
  runJson: FileText;
  sessionsTsv: FileText;
  sessionRecords: FileText[];
  decisions: { name: string; text: FileText }[];
  lastActivity: number | null;
  /** Listings inside the run that failed: its session records or decisions may be missing. */
  unlisted: string[];
}

export interface SandboxFiles {
  id: string;
  verdict: FileText;
  /** When the host wrote verdict.json (ms), or null while there is none. */
  decidedAt: number | null;
  lastActivity: number | null;
}

/** Why entries may be missing from each artifact collection; an empty list means none are. */
export interface Incomplete {
  runs: string[];
  hostReviews: string[];
  pauses: string[];
  lock: string[];
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
  /** `text` is null when the review folder holds no decision.json. */
  hostReviews: { run: string; slug: string; text: FileText }[];
  batch: { state: FileText; lock: { owner: FileText } | null };
  pauses: { name: string; text: FileText }[];
  /** Quarantined and parked branches; null when Git could not list them. */
  branches: GitBranch[] | null;
  incomplete: Incomplete;
  gaps: Gap[];
}

const REGISTER = "docs/technical-debt.md";
const RUN_ID = /^\d{8}-\d{6}$/;
const NO_RALPH = "no .ralph/ in this checkout (Ralph writes it only where it runs)";

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** Reads that report failures instead of hiding them. A failed listing goes to `failures`. */
function reader(sources: Sources, gaps: Gap[]) {
  const listing = (path: string, failures: string[]): DirEntry[] => {
    try {
      return sources.list(path) ?? [];
    } catch (error) {
      gaps.push({ source: path, reason: messageOf(error) });
      failures.push(`${path} could not be listed: ${messageOf(error)}`);
      return [];
    }
  };
  return {
    dirs: (path: string, failures: string[]) =>
      listing(path, failures)
        .filter((entry) => entry.isDirectory)
        .map((entry) => entry.name),
    files: (path: string, failures: string[]) =>
      listing(path, failures)
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.name),
    /** Whether a directory exists; a failed check counts as unknown, recorded in `failures`. */
    exists: (path: string, failures: string[]): boolean => {
      try {
        return sources.list(path) !== null;
      } catch (error) {
        gaps.push({ source: path, reason: messageOf(error) });
        failures.push(`${path} could not be listed: ${messageOf(error)}`);
        return false;
      }
    },
    /** A modification time; a directory that could not be listed is recorded in `failures`. */
    modified: (path: string, failures: string[]): number | null => {
      try {
        return sources.lastModified(path);
      } catch (error) {
        gaps.push({ source: path, reason: messageOf(error) });
        failures.push(`${path} could not be listed: ${messageOf(error)}`);
        return null;
      }
    },
    text: (path: string): FileText => {
      try {
        return sources.read(path);
      } catch (error) {
        return { unreadable: messageOf(error) };
      }
    },
    /** A file a listing just named: if it is gone by the time it is read, the read failed. */
    listed: (path: string): FileText => {
      try {
        return sources.read(path) ?? { unreadable: "disappeared while being read" };
      } catch (error) {
        return { unreadable: messageOf(error) };
      }
    },
  };
}
type Reader = ReturnType<typeof reader>;

function readRun(read: Reader, path: string, runId: string, origin: string): RunFiles {
  const unlisted: string[] = [];
  const names = read.files(path, unlisted);
  return {
    runId,
    origin,
    runJson: read.text(`${path}/run.json`),
    sessionsTsv: read.text(`${path}/sessions.tsv`),
    sessionRecords: read
      .files(`${path}/sessions`, unlisted)
      .filter((name) => name.endsWith(".tsv"))
      .sort()
      .map((name) => read.listed(`${path}/sessions/${name}`)),
    decisions: names
      .filter((name) => /\.review-\d+\.decision\.json$/.test(name))
      .map((name) => ({ name, text: read.listed(`${path}/${name}`) })),
    lastActivity: Math.max(
      read.modified(path, unlisted) ?? 0,
      read.modified(`${path}/sessions`, unlisted) ?? 0,
    ),
    unlisted,
  };
}

function readTickets(
  sources: Sources,
  commit: string,
  ref: string,
  gaps: Gap[],
): Snapshot["tickets"] {
  try {
    const all = sources.filesAt(commit, "issues");
    return [...all.entries()]
      .filter(([path]) => /^issues\/(done\/)?[^/]+$/.test(path))
      .filter(([path]) => isTicketFileName(path.split("/").pop() ?? ""))
      .map(([path, text]) => ({ path, text }));
  } catch (error) {
    gaps.push({ source: `issues/ at ${ref}`, reason: messageOf(error) });
    return null;
  }
}

function readRegister(sources: Sources, commit: string, ref: string, gaps: Gap[]) {
  try {
    const text = sources.filesAt(commit, REGISTER).get(REGISTER);
    if (text === undefined) {
      gaps.push({ source: `${REGISTER} at ${ref}`, reason: "file does not exist at this ref" });
    }
    return text ?? null;
  } catch (error) {
    gaps.push({ source: `${REGISTER} at ${ref}`, reason: messageOf(error) });
    return null;
  }
}

function readBranches(sources: Sources, gaps: Gap[]): GitBranch[] | null {
  try {
    return [...sources.branches("rejected/"), ...sources.branches("ralph/paused/")];
  } catch (error) {
    gaps.push({ source: "git branches rejected/* and ralph/paused/*", reason: messageOf(error) });
    return null;
  }
}

function readRalph(sources: Sources, gaps: Gap[]) {
  const read = reader(sources, gaps);
  const incomplete: Incomplete = { runs: [], hostReviews: [], pauses: [], lock: [] };
  // Without .ralph/ (the dashboard pointed at a checkout Ralph does not run in, or a failed
  // check), nothing below it is known: not "no runs", not "lock free".
  const ralph: string[] = [];
  if (!read.exists(".ralph", ralph)) {
    const reason = ralph[0] ?? NO_RALPH;
    if (ralph.length === 0) {
      gaps.push({ source: ".ralph/", reason });
    }
    for (const list of Object.values(incomplete)) {
      list.push(reason);
    }
  }

  const runs = read
    .dirs(".ralph/logs", incomplete.runs)
    .filter((name) => RUN_ID.test(name))
    .map((name) => readRun(read, `.ralph/logs/${name}`, name, "logs"));
  const sandboxes: SandboxFiles[] = [];
  for (const id of read.dirs(".ralph/sandbox", incomplete.runs)) {
    const base = `.ralph/sandbox/${id}`;
    sandboxes.push({
      id,
      verdict: read.text(`${base}/verdict.json`),
      decidedAt: read.modified(`${base}/verdict.json`, incomplete.runs),
      lastActivity:
        read.modified(`${base}/out/logs`, incomplete.runs) ?? read.modified(base, incomplete.runs),
    });
    // A run still inside a sandbox writes its logs to out/logs; the host copies them to
    // .ralph/logs only when it accepts or refuses the result.
    for (const runId of read
      .dirs(`${base}/out/logs`, incomplete.runs)
      .filter((name) => RUN_ID.test(name))) {
      if (!runs.some((run) => run.runId === runId)) {
        runs.push(readRun(read, `${base}/out/logs/${runId}`, runId, `sandbox ${id}`));
      }
    }
  }

  const hostReviews = read.dirs(".ralph/host-review", incomplete.hostReviews).flatMap((run) =>
    read.dirs(`.ralph/host-review/${run}`, incomplete.hostReviews).map((slug) => ({
      run,
      slug,
      text: read.text(`.ralph/host-review/${run}/${slug}/decision.json`),
    })),
  );

  const lockPresent = read.exists(".ralph/batch/lock", incomplete.lock);
  return {
    runs,
    sandboxes,
    hostReviews,
    batch: {
      state: read.text(".ralph/batch/state.json"),
      lock: lockPresent ? { owner: read.text(".ralph/batch/lock/owner.json") } : null,
    },
    pauses: read
      .files(".ralph/state", incomplete.pauses)
      .filter((name) => name.endsWith(".pause"))
      .map((name) => ({ name, text: read.listed(`.ralph/state/${name}`) })),
    incomplete,
  };
}

export function takeSnapshot(
  sources: Sources,
  options: { root: string; ref: string; now: number },
): Snapshot {
  const { ref } = options;
  const gaps: Gap[] = [];
  // The ref is resolved once, and everything read from Git below uses that commit: if another
  // process moves the ref mid-snapshot, tickets and the register still describe the same commit.
  // A failure is reported, not retried and not replaced by an older answer.
  const lookup = sources.commitOf(ref);
  const commit = lookup.ok ? lookup.commit : null;
  if (!lookup.ok) {
    gaps.push({ source: `git ref ${ref}`, reason: lookup.reason });
  }
  const ralph = readRalph(sources, gaps);
  return {
    takenAt: options.now,
    root: options.root,
    ref,
    commit,
    tickets: commit === null ? null : readTickets(sources, commit, ref, gaps),
    register: commit === null ? null : readRegister(sources, commit, ref, gaps),
    ...ralph,
    branches: readBranches(sources, gaps),
    gaps,
  };
}
