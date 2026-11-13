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
  /** Entries of `<root>/<path>`, or null when it does not exist or is not a directory. */
  list(path: string): DirEntry[] | null;
  /** Contents of `<root>/<path>`, or null when it does not exist or cannot be read. */
  read(path: string): string | null;
  /** Newest modification time (ms) of `<root>/<path>` and the files directly inside it. */
  lastModified(path: string): number | null;
  /** Commit the ref names, or null when the ref does not exist. */
  commitOf(ref: string): string | null;
  /** Every file at `ref` below `prefix`, with its contents. Throws when Git fails. */
  filesAt(ref: string, prefix: string): Map<string, string>;
  /** Local branches below `refs/heads/<prefix>`. */
  branches(prefix: string): GitBranch[];
}

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

export function createSources(root: string): Sources {
  const env = gitEnvironment();
  const git = (args: string[], input?: string): Buffer =>
    execFileSync("git", ["-C", root, ...args], {
      env,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    });
  const stat = (path: string) => {
    try {
      return statSync(join(root, path));
    } catch {
      return null;
    }
  };

  return {
    list(path) {
      try {
        return readdirSync(join(root, path), { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      } catch {
        return null;
      }
    },
    read(path) {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    lastModified(path) {
      const own = stat(path);
      if (own === null) {
        return null;
      }
      const children = this.list(path) ?? [];
      return Math.max(
        own.mtimeMs,
        ...children.map((child) => stat(join(path, child.name))?.mtimeMs ?? 0),
      );
    },
    commitOf(ref) {
      try {
        return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
          .toString()
          .trim();
      } catch {
        return null;
      }
    },
    filesAt(ref, prefix) {
      const paths = git(["ls-tree", "-r", "--name-only", "-z", ref, "--", prefix])
        .toString("utf8")
        .split("\0")
        .filter((path) => path !== "");
      if (paths.length === 0) {
        return new Map();
      }
      const request = paths.map((path) => `${ref}:${path}`).join("\n");
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
