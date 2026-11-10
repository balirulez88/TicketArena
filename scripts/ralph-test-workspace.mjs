// A disposable workspace for one harness test process. A test file imports this module and its
// fixtures, and those of every child process it starts, land in a session folder that is removed
// when the tests no longer need it. It exists because the suites left over 18,000 Git repositories
// in the Windows TEMP directory, enough to fill C: and fail tests falsely.
//
// It redirects TEMP, TMP and TMPDIR instead of asking for a new call at each fixture, so stubs and
// harness scripts started by a test are covered without knowing about it.
//
//   RALPH_TEST_TMP_ROOT     absolute root (default: <repository>/.ralph/tmp/harness). There is no
//                           fallback to the system's directory: an unusable root is an error.
//   RALPH_TEST_KEEP_FAILED  "1" keeps a failed test's directories under <root>/kept-failed.
//
// Layout under the root: sessions/ (swept) and kept-failed/ (never removed here). Nothing else
// under the root is touched, so earlier failure-injection evidence kept there survives every run.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const OWNER_FILE = /^(session-[\w-]+)\.owner\.json$/;
// What Git calls repository-local variables (`git rev-parse --local-env-vars`). A hook or
// `rebase -x` exports some of them, and they outrank discovery: with GIT_DIR set, a fixture's
// `git commit` lands in the real repository whatever GIT_CEILING_DIRECTORIES says.
const GIT_LOCAL_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

const isStrictlyInside = (parent, child) => {
  const path = relative(parent, child);
  return path !== "" && path.split(sep)[0] !== ".." && !isAbsolute(path);
};

/** Cleanup only ever runs below the root, so the root's position is what protects the repository. */
function assertSafeRoot(root) {
  // relative(), not ===: on Windows two spellings differing in case are the same directory.
  if (relative(root, REPOSITORY) === "" || isStrictlyInside(root, REPOSITORY)) {
    throw new Error(`RALPH_TEST_TMP_ROOT ${root} is or contains the repository; choose another`);
  }
  if (!isStrictlyInside(REPOSITORY, root)) {
    return;
  }
  const scratch = join(REPOSITORY, ".ralph", "tmp");
  if (!isStrictlyInside(scratch, root)) {
    throw new Error(
      `RALPH_TEST_TMP_ROOT ${root} is inside the repository but not below ${scratch}`,
    );
  }
  if (/^failure-injection/i.test(relative(scratch, root).split(sep)[0] ?? "")) {
    throw new Error(`RALPH_TEST_TMP_ROOT ${root} is inside preserved failure-injection evidence`);
  }
}

/** Where a root that may not exist yet would really land, following any link on the way to it. */
function resolveThroughLinks(path) {
  const missing = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch (error) {
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function openRoot() {
  const { RALPH_TEST_TMP_ROOT: configured } = process.env;
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error(`RALPH_TEST_TMP_ROOT must be an absolute path, got "${configured}"`);
  }
  const requested =
    configured === undefined ? join(REPOSITORY, ".ralph", "tmp", "harness") : resolve(configured);
  // Before anything is created, and not only after: a link can make a root that looks external
  // land in the repository, and mkdir would then write there.
  assertSafeRoot(resolveThroughLinks(requested));
  let root;
  try {
    mkdirSync(join(requested, "sessions"), { recursive: true });
    root = realpathSync(requested);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `RALPH_TEST_TMP_ROOT ${requested} is unavailable, and the tests do not fall back to the system's temporary directory: ${reason}`,
    );
  }
  // Again now that the root exists: a link may have been created since the check above.
  assertSafeRoot(root);
  return root;
}

/**
 * Name and start time of each process that exists. The start time is what tells a session's owner
 * from a later process that was given the same ID. Null means the system could not be asked, and
 * a process listed with an empty start time could not be read; neither proves anything.
 */
function identifyProcesses(pids) {
  if (process.platform === "linux") {
    return identifyOnLinux(pids);
  }
  return process.platform === "win32" ? identifyOnWindows() : null;
}

function identifyOnLinux(pids) {
  const table = new Map();
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      // The name may hold spaces and parentheses; after it, the start time is field 22 of stat.
      table.set(pid, {
        name: stat.slice(stat.indexOf("(") + 1, close),
        startTime: stat.slice(close + 2).split(" ")[19] ?? "",
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return null;
      }
    }
  }
  return table;
}

function identifyOnWindows() {
  // Every process, not `-Id`: that form exits 1 when one ID is gone, and a dead ID is the very
  // answer wanted here. Reading another user's start time throws, which leaves it empty.
  const script = `$ErrorActionPreference='Stop'; Get-Process | ForEach-Object { $t=''; try { $t=$_.StartTime.ToUniversalTime().Ticks } catch {}; "$($_.Id)\`t$($_.ProcessName)\`t$t" }`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const table = new Map();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [pid, name, startTime] = line.split("\t");
    table.set(Number(pid), { name, startTime: startTime ?? "" });
  }
  return table;
}

/** The file is whatever a crashed or hostile process left, so nothing in it is trusted unchecked. */
function readOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    const valid =
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.name === "string" &&
      (typeof owner.startTime === "string" || owner.startTime === null) &&
      typeof owner.hostname === "string";
    return valid ? owner : null;
  } catch {
    return null;
  }
}

/** Removes one entry and never what a link points to, whatever kind of link it is. */
function removeEntry(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  // Retries cover the moments Windows still holds a file a finished Git process used.
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const warn = (message, error) =>
  console.error(
    `[test-workspace] ${message}: ${error instanceof Error ? error.message : String(error)}`,
  );

/** The owner record goes last: if a removal fails, the next run can still prove and retry it. */
function removeSession(sessions, name) {
  try {
    removeEntry(join(sessions, name));
    rmSync(join(sessions, `${name}.owner.json`), { force: true });
  } catch (error) {
    warn(`could not remove ${name}; the next run retries`, error);
  }
}

/**
 * Removes the sessions of processes proven dead. A hard kill runs no cleanup at all on Windows,
 * not even an exit handler, so this is the only recovery from one. Anything unproven stays.
 *
 * Judges exactly the owners the table was built from: an owner read afterwards has no entry, and
 * no entry means dead, so another test file starting at this moment would lose its live session.
 */
export function recoverDeadSessions(sessions, owners, table) {
  if (table === null) {
    return;
  }
  for (const { name, owner } of owners) {
    if (owner === null || owner.startTime === null || owner.hostname !== hostname()) {
      continue;
    }
    const running = table.get(owner.pid);
    if (running !== undefined && running.startTime === "") {
      continue;
    }
    if (running?.name !== owner.name || running?.startTime !== owner.startTime) {
      removeSession(sessions, name);
    }
  }
}

function listOwners(sessions) {
  return readdirSync(sessions).flatMap((entry) => {
    const name = OWNER_FILE.exec(entry)?.[1];
    return name === undefined ? [] : [{ name, owner: readOwner(join(sessions, entry)) }];
  });
}

function openSession(root) {
  const sessions = join(root, "sessions");
  const owners = listOwners(sessions);
  const others = owners.flatMap(({ owner }) => (owner === null ? [] : [owner.pid]));
  const table = identifyProcesses([...new Set([process.pid, ...others])]);
  recoverDeadSessions(sessions, owners, table);
  const self = table?.get(process.pid);
  const name = `session-${process.pid}-${randomBytes(4).toString("hex")}`;
  // The owner is on disk before the directory, so no session ever exists without one.
  writeFileSync(
    join(sessions, `${name}.owner.json`),
    JSON.stringify({
      pid: process.pid,
      name: self?.name ?? "",
      startTime: self?.startTime ? self.startTime : null,
      hostname: hostname(),
    }),
  );
  const session = join(sessions, name);
  mkdirSync(join(session, "tmp"), { recursive: true });
  return { name, session, sessions, tmp: join(session, "tmp") };
}

const root = openRoot();
const { name: sessionName, session, sessions, tmp } = openSession(root);
export const workspace = Object.freeze({ root, session, tmp });

// Git and Bash both accept forward slashes on Windows; backslashes do not survive Bash.
const portable = (path) => path.replaceAll(sep, "/");
process.env.TEMP = portable(tmp);
process.env.TMP = portable(tmp);
process.env.TMPDIR = portable(tmp);
// The workspace defaults to a folder inside the checkout. Without this, Git run in a fixture that
// is not yet a repository would find and change the real TicketArena repository above it.
const { GIT_CEILING_DIRECTORIES: inheritedCeiling, RALPH_TEST_KEEP_FAILED: keepFlag } = process.env;
process.env.GIT_CEILING_DIRECTORIES = [portable(sessions), inheritedCeiling]
  .filter(Boolean)
  .join(delimiter);
for (const name of GIT_LOCAL_VARIABLES) {
  delete process.env[name];
}

let released = false;
function release() {
  if (!released) {
    released = true;
    removeSession(sessions, sessionName);
  }
}
process.once("exit", release);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    release();
    // The test runner's own handler ends the process when it has one; otherwise this must.
    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  });
}

function keepFailed(name) {
  const target = join(root, "kept-failed", sessionName);
  mkdirSync(target, { recursive: true });
  renameSync(join(tmp, name), join(target, name));
}

// File-level fixtures predate the snapshot, so a test removes only the directories it made.
let existing = new Set();
beforeEach(() => {
  existing = new Set(readdirSync(tmp));
});
afterEach((context) => {
  const keep = context.passed === false && keepFlag === "1";
  for (const name of readdirSync(tmp).filter((entry) => !existing.has(entry))) {
    try {
      if (keep) {
        keepFailed(name);
      } else {
        removeEntry(join(tmp, name));
      }
    } catch (error) {
      // A failed removal must not turn a verdict: the session's removal retries it.
      warn(`could not clear ${name}`, error);
    }
  }
});
