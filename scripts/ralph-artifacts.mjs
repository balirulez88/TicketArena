#!/usr/bin/env node
//
// Lifecycle of Ralph's run artifacts. Two roots, both holding one directory per run id
// (YYYYMMDD-HHMMSS):
//
//   review root  .ralph/review/<run-id>/  temporary: the changesets the reviewers read
//   log root     .ralph/logs/<run-id>/    persistent: agent and gate logs, reports, decisions,
//                                          a copy of every reviewed changeset, run.json
//
// Retention (decided from the run's run.json in the log root; directory age if it has none):
//   - an `active` run is never touched, however old: it may be running or resumable;
//   - temporary review files of a `succeeded` run are deleted once the run is finalized (their
//     copies are archived in the run's logs); of a `failed` run, 7 days after it finished;
//   - logs are deleted 30 days after the run finished.
//
// Safety: a root is only cleaned if it carries the `.ralph-managed` marker that `init` writes.
// Only direct children named like a run id are removed, never symlinks, never anything outside.
//
// Usage: node scripts/ralph-artifacts.mjs init --root <dir>
//        node scripts/ralph-artifacts.mjs mark --run <log dir> --status active|succeeded|failed
//        node scripts/ralph-artifacts.mjs remove --root <review root> --run-id <id>
//        node scripts/ralph-artifacts.mjs cleanup --review-root <dir> --log-root <dir> [--keep <id>]
//        node scripts/ralph-artifacts.mjs redact --run <log dir>

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const MARKER = ".ralph-managed";
export const RUN_ID = /^\d{8}-\d{6}$/;
export const FAILED_REVIEW_RETENTION_DAYS = 7;
export const LOG_RETENTION_DAYS = 30;
const STATUSES = ["active", "succeeded", "failed"];
const DAY_MS = 24 * 60 * 60 * 1000;

export function initRoot(root) {
  mkdirSync(root, { recursive: true });
  const marker = join(root, MARKER);
  if (!existsSync(marker)) {
    writeFileSync(marker, "Managed by ralph-loop.sh: run directories here are deleted by age.\n");
  }
}

function readRunMeta(logDir) {
  try {
    return JSON.parse(readFileSync(join(logDir, "run.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function markRun(logDir, status, now = new Date()) {
  if (!STATUSES.includes(status)) {
    throw new Error(`--status must be one of ${STATUSES.join(", ")}`);
  }
  const previous = readRunMeta(logDir) ?? {};
  const meta = {
    run_id: basename(logDir),
    status,
    started_at: previous.started_at ?? now.toISOString(),
    finished_at: status === "active" ? null : now.toISOString(),
  };
  writeFileSync(join(logDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/** The run directories a root may lose: real directories named like a run id, inside the root. */
function runDirectories(root) {
  if (!existsSync(join(root, MARKER))) {
    throw new Error(
      `${root} is not a Ralph-managed directory (no ${MARKER}); refusing to clean it`,
    );
  }
  const realRoot = realpathSync(root);
  return readdirSync(realRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
    .map((entry) => join(realRoot, entry.name))
    .filter((path) => dirname(path) === realRoot && !lstatSync(path).isSymbolicLink());
}

function finishedAt(meta, path) {
  const finished = Date.parse(meta?.finished_at ?? "");
  return Number.isNaN(finished) ? statSync(path).mtimeMs : finished;
}

function reviewExpired(meta, path, now) {
  if (meta?.status === "succeeded") {
    return true;
  }
  return now - finishedAt(meta, path) > FAILED_REVIEW_RETENTION_DAYS * DAY_MS;
}

const logExpired = (meta, path, now) => now - finishedAt(meta, path) > LOG_RETENTION_DAYS * DAY_MS;

/** Deletes expired run directories; returns the paths it removed. Safe to run repeatedly. */
export function cleanup({ reviewRoot, logRoot, keep, now = Date.now() }) {
  const removed = [];
  const sweep = (root, expired) => {
    if (!existsSync(root)) {
      return;
    }
    for (const path of runDirectories(root)) {
      const id = basename(path);
      const meta = readRunMeta(join(logRoot, id));
      if (id === keep || meta?.status === "active" || !expired(meta, path, now)) {
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  };
  // Reviews first: their retention reads the run's metadata, which lives in the logs.
  sweep(reviewRoot, reviewExpired);
  sweep(logRoot, logExpired);
  return removed;
}

/** Removes one finished run's temporary review directory. */
export function removeRun(root, runId) {
  if (!RUN_ID.test(runId)) {
    throw new Error(`--run-id must look like YYYYMMDD-HHMMSS (got "${runId}")`);
  }
  if (!existsSync(root)) {
    return false;
  }
  const target = runDirectories(root).find((path) => basename(path) === runId);
  if (target) {
    rmSync(target, { recursive: true, force: true });
  }
  return Boolean(target);
}

// --- Secret redaction --------------------------------------------------------------------------

const SECRET_NAME = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/g];

export function secretValues(env) {
  return Object.entries(env)
    .filter(
      ([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8,
    )
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

export function redactText(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/** Rewrites every regular file under a run's log directory without the given secrets. */
export function redactRun(logDir, secrets) {
  const redacted = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path);
      } else if (entry.isFile()) {
        const text = readFileSync(path, "utf8");
        const clean = redactText(text, secrets);
        if (clean !== text) {
          writeFileSync(path, clean);
          redacted.push(path);
        }
      }
    }
  };
  if (existsSync(logDir)) {
    walk(logDir);
  }
  return redacted;
}

// --- CLI ---------------------------------------------------------------------------------------

const COMMANDS = {
  init: (values) => initRoot(values.root),
  mark: (values) => markRun(values.run, values.status),
  remove: (values) => removeRun(values.root, values["run-id"]),
  cleanup: (values) => {
    for (const path of cleanup({
      reviewRoot: values["review-root"],
      logRoot: values["log-root"],
      keep: values.keep,
    })) {
      console.error(`ralph-artifacts: removed expired ${path}`);
    }
  },
  redact: (values) => {
    for (const path of redactRun(values.run, secretValues(process.env))) {
      console.error(`ralph-artifacts: redacted secrets in ${path}`);
    }
  },
};

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      run: { type: "string" },
      status: { type: "string" },
      "run-id": { type: "string" },
      "review-root": { type: "string" },
      "log-root": { type: "string" },
      keep: { type: "string" },
    },
  });
  const command = COMMANDS[positionals[0] ?? ""];
  if (!command) {
    throw new Error(`usage: ralph-artifacts.mjs ${Object.keys(COMMANDS).join("|")} [options]`);
  }
  command(values);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ralph-artifacts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
