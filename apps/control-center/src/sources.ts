// The only module that touches the disk or runs Git. Everything it does is a read: directory
// listings, file reads, `stat`, and the Git plumbing commands `rev-parse`, `ls-tree`, `cat-file`
// and `for-each-ref`. It never writes, locks or checks anything out, so the dashboard can run
// beside a live Ralph run, a batch, or another worktree's work without changing what they see.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GitBranch } from "./model";

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface Sources {
  /** Entries of `<root>/<path>`; null when it does not exist or is not a directory; else throws. */
  list(path: string): DirEntry[] | null;
  /** Contents of `<root>/<path>`; null when it does not exist; throws when it cannot be read. */
  read(path: string): string | null;
  /**
   * Newest modification time (ms) of `<root>/<path>` and the files directly inside it; null when
   * it does not exist; throws when it is a directory that cannot be listed.
   */
  lastModified(path: string): number | null;
  /** The commit the ref names right now, or why Git could not resolve it (in Git's words). */
  commitOf(ref: string): CommitLookup;
  /** Every file at `revision` below `prefix`, with its contents. Throws when Git fails. */
  filesAt(revision: string, prefix: string): Map<string, string>;
  /** Local branches below `refs/heads/<prefix>`. Throws when Git fails. */
  branches(prefix: string): GitBranch[];
}

export type CommitLookup = { ok: true; commit: string } | { ok: false; reason: string };

/**
 * Runs one Git command in the repository and returns its stdout. Fails like `execFileSync`: an
 * error carrying the exit `status` and the `stderr` Git wrote. The process boundary, injectable so
 * tests can stand in for a Git that fails.
 */
export type GitRunner = (args: readonly string[], input?: string) => Buffer;

// Git's repository-local variables outrank `-C`: a hook in a linked worktree exports an absolute
// GIT_DIR (TD-091), which would make every read below answer for some other repository.
const GIT_LOCAL_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_LOCAL_VARIABLES) {
    delete env[name];
  }
  return env;
}

const MAX_BUFFER = 64 * 1024 * 1024;

// "Does not exist" is an answer; a permission or I/O error is not, and must not read as one.
const ABSENT = ["ENOENT", "ENOTDIR"];
const isAbsent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && ABSENT.includes(String(error.code));

// `git cat-file --batch` output: `<sha> blob <size>\n<content>\n` per object, in request order.
function splitBatch(output: Buffer, paths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  for (const path of paths) {
    const newline = output.indexOf(10, offset);
    const header = output.subarray(offset, newline).toString("utf8");
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]);
    if (newline === -1 || !Number.isInteger(size)) {
      throw new Error(`git cat-file returned "${header}" for ${path}`);
    }
    files.set(path, output.subarray(newline + 1, newline + 1 + size).toString("utf8"));
    offset = newline + 1 + size + 1;
  }
  return files;
}

export function createGitRunner(root: string): GitRunner {
  const env = gitEnvironment();
  return (args, input) =>
    execFileSync("git", ["-C", root, ...args], {
      env,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    });
}

/** `git <command> failed (exit N): <what Git wrote>`, on one line, keeping Git's own words. */
function describeGitFailure(args: readonly string[], error: unknown): string {
  const status = error instanceof Error && "status" in error ? error.status : null;
  const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "";
  const said = stderr.trim().split(/\r?\n/).join(" ");
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  return `git ${args[0] ?? ""} failed (exit ${typeof status === "number" ? status : "unknown"}): ${said || message}`;
}

// What `rev-parse --verify` writes when the name resolves to nothing. On Windows a ref that another
// process is rewriting (a merge, `pack-refs`) can briefly resolve to nothing too, so this is "not
// found when read", never "does not exist". Nothing retries it: the next refresh reads again.
const NOT_FOUND = /Needed a single revision/;

export function createSources(root: string, runGit: GitRunner = createGitRunner(root)): Sources {
  const git = (args: readonly string[], input?: string): Buffer => {
    try {
      return runGit(args, input);
    } catch (error) {
      throw new Error(describeGitFailure(args, error));
    }
  };
  const stat = (path: string) => {
    try {
      return statSync(join(root, path));
    } catch {
      return null;
    }
  };

  const absentOr = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch (error) {
      if (isAbsent(error)) {
        return null;
      }
      throw error;
    }
  };

  return {
    list(path) {
      return absentOr(() =>
        readdirSync(join(root, path), { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        })),
      );
    },
    read(path) {
      return absentOr(() => readFileSync(join(root, path), "utf8"));
    },
    lastModified(path) {
      const own = stat(path);
      if (own === null) {
        return null;
      }
      // A directory that exists but cannot be listed throws: its own time alone could make a run
      // that is writing files look quiet, and the caller must report that as unknown instead.
      const children: DirEntry[] = own.isDirectory() ? (this.list(path) ?? []) : [];
      return Math.max(
        own.mtimeMs,
        ...children.map((child) => stat(join(path, child.name))?.mtimeMs ?? 0),
      );
    },
    commitOf(ref) {
      // No --quiet: it would hide Git's message, and the message is what tells a missing ref
      // apart from a permission or repository error.
      const args = ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`];
      try {
        return { ok: true, commit: runGit(args).toString().trim() };
      } catch (error) {
        const reason = describeGitFailure(args, error);
        return NOT_FOUND.test(reason)
          ? {
              ok: false,
              reason: `not found when read (missing, or being rewritten by another Git process at that moment); ${reason}`,
            }
          : { ok: false, reason };
      }
    },
    filesAt(revision, prefix) {
      const paths = git(["ls-tree", "-r", "--name-only", "-z", revision, "--", prefix])
        .toString("utf8")
        .split("\0")
        .filter((path) => path !== "");
      if (paths.length === 0) {
        return new Map();
      }
      const request = paths.map((path) => `${revision}:${path}`).join("\n");
      return splitBatch(git(["cat-file", "--batch"], `${request}\n`), paths);
    },
    branches(prefix) {
      const format = "%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)";
      return git(["for-each-ref", `--format=${format}`, `refs/heads/${prefix}`])
        .toString("utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [name = "", sha = "", date = "", ...subject] = line.split("\t");
          return { name, sha, date, subject: subject.join("\t") };
        });
    },
  };
}
