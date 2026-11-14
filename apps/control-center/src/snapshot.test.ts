import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeSnapshot } from "./snapshot";
import { createGitRunner, createSources, type GitRunner } from "./sources";
import { buildState } from "./state";
import { debtEntry, register, triagedLow } from "./testing/fixtures";

// The fixture is a real Git repository on disk: the reads under test are Git plumbing and file
// system calls, the system boundary this module owns.

const NOW = Date.parse("2026-11-13T12:00:00Z");
let root: string;
let decoy: string;

const cleanGitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of Object.keys(env).filter((key) => key.startsWith("GIT_"))) {
    delete env[name];
  }
  return { ...env, GIT_CEILING_DIRECTORIES: dirname(root) };
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, env: cleanGitEnv(), stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString()
    .trim();

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const ticketText = (number: string, status: string, blockedBy = "None") =>
  `# ${number}: Ticket ${number}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n`;

// Content and modification time of every file, .git included.
function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        hash.update(`${relative(dir, path)}:${statSync(path).mtimeMs}:`);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "control-center-"));
  root = join(base, "repo");
  decoy = join(base, "decoy");
  mkdirSync(root);
  mkdirSync(decoy);
  git(root, "init", "--quiet", "--initial-branch=main");
  write("issues/01-first.md", ticketText("01", "ready-for-agent"));
  write("issues/02-second.md", ticketText("02", "ready-for-agent", "01"));
  write("issues/done/03-third.md", ticketText("03", "done"));
  write("issues/README.md", "# not a ticket\n");
  write("docs/technical-debt.md", register(debtEntry("TD-001", triagedLow("02", "ticket 01"))));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "tickets");
  git(root, "branch", "rejected/01-first-20261108-175232");
  // The checkout is on another branch with an uncommitted edit: Ralph selects from main.
  git(root, "switch", "--quiet", "-c", "feature");
  write("issues/01-first.md", ticketText("01", "done"));

  write(".ralph/logs/20261113-110000/run.json", '{"run_id":"20261113-110000","status":"active"}');
  write(
    ".ralph/logs/20261113-110000/sessions/20261113T110000-a.tsv",
    "2026-11-13T11:00:00Z\t01 green#1\ta\trunning\t-\t-\n",
  );
  write(
    ".ralph/logs/20261113-110000/01-first.review-1.decision.json",
    '{"verdict":"blocked","blockers":[],"findings":[]}',
  );
  write(".ralph/logs/not-a-run/run.json", "{}");
  write(
    ".ralph/sandbox/20261113-120000-9/out/logs/20261113-110500/run.json",
    '{"run_id":"20261113-110500","status":"active"}',
  );
  write(".ralph/sandbox/20261112-090000-8/verdict.json", '{"exit":1,"outcome":"rejected"}');
  write(".ralph/host-review/20261112-090000-8/02-second/decision.json", '{"verdict":"blocked"}');
  write(".ralph/batch/lock/owner.json", '{"pid":4242,"host":"devbox"}');
  write(".ralph/state/01-first.pause", "ticket=01\nphase=green\n");

  git(decoy, "init", "--quiet", "--initial-branch=main");
  git(decoy, "commit", "--quiet", "--allow-empty", "-m", "decoy");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dirname(root), { recursive: true, force: true });
});

describe("takeSnapshot", () => {
  it("reads tickets and the register at the ref, not from the checked-out working tree", () => {
    const snap = takeSnapshot(createSources(root), { root, ref: "main", now: NOW });
    expect(snap.commit).toBe(git(root, "rev-parse", "main"));
    expect(snap.tickets?.map((t) => t.path).sort()).toEqual([
      "issues/01-first.md",
      "issues/02-second.md",
      "issues/done/03-third.md",
    ]);
    expect(snap.tickets?.find((t) => t.path === "issues/01-first.md")?.text).toContain(
      "**Status:** ready-for-agent",
    );
    expect(snap.register).toContain("### TD-001");
  });

  it("collects run directories, sandbox runs, host reviews, batch lock, pauses and branches", () => {
    const snap = takeSnapshot(createSources(root), { root, ref: "main", now: NOW });
    expect(snap.runs.map((r) => [r.runId, r.origin])).toEqual([
      ["20261113-110000", "logs"],
      ["20261113-110500", "sandbox 20261113-120000-9"],
    ]);
    expect(snap.runs[0]?.sessionRecords).toHaveLength(1);
    expect(snap.runs[0]?.decisions.map((d) => d.name)).toEqual(["01-first.review-1.decision.json"]);
    expect(snap.runs[0]?.lastActivity).toBeGreaterThan(0);
    expect(snap.sandboxes.find((s) => s.id === "20261112-090000-8")?.decidedAt).toBeGreaterThan(0);
    expect(snap.hostReviews).toEqual([
      { run: "20261112-090000-8", slug: "02-second", text: '{"verdict":"blocked"}' },
    ]);
    expect(snap.batch).toEqual({ state: null, lock: { owner: '{"pid":4242,"host":"devbox"}' } });
    expect(snap.pauses.map((p) => p.name)).toEqual(["01-first.pause"]);
    expect(snap.branches?.map((b) => b.name)).toEqual(["rejected/01-first-20261108-175232"]);
  });

  it("changes nothing in the repository, its .git or its artifacts", async () => {
    // Fingerprint only: even `git status` would rewrite .git/index while refreshing it.
    const before = fingerprint(root);
    await buildState(takeSnapshot(createSources(root), { root, ref: "main", now: NOW }), {
      staleAfterMs: 60_000,
      failureLimit: 25,
    });
    expect(fingerprint(root)).toBe(before);
  });

  it("ignores an inherited GIT_DIR that points at another repository", () => {
    vi.stubEnv("GIT_DIR", join(decoy, ".git"));
    const snap = takeSnapshot(createSources(root), { root, ref: "main", now: NOW });
    expect(snap.commit).not.toBe(git(decoy, "rev-parse", "main"));
    expect(snap.tickets).toHaveLength(3);
  });

  it("reports a missing ref and a missing .ralph directory as gaps", () => {
    rmSync(join(root, ".ralph"), { recursive: true });
    const snap = takeSnapshot(createSources(root), { root, ref: "nope", now: NOW });
    expect(snap.commit).toBeNull();
    expect(snap.tickets).toBeNull();
    expect(snap.gaps.map((gap) => gap.source)).toEqual(["git ref nope", ".ralph/"]);
    // Without .ralph/ nothing below it is known, so no collection may read as empty.
    expect(snap.incomplete.runs).toHaveLength(1);
    expect(snap.incomplete.lock).toHaveLength(1);
  });

  it("keeps an active run's state unknown when its activity listing fails", async () => {
    // The run directory lists once (its files are read) and then fails when its activity time is
    // taken: a transient EACCES between two reads of the same directory.
    const real = createSources(root);
    const path = ".ralph/logs/20261113-110000";
    let calls = 0;
    const sources = {
      ...real,
      list(dir: string) {
        if (dir === path && ++calls > 1) {
          throw new Error(`EACCES: permission denied, scandir '${dir}'`);
        }
        return real.list(dir);
      },
    };
    // Two hours on: by its directory's own time alone the run would look quiet.
    const later = Date.now() + 120 * 60_000;
    const snap = takeSnapshot(sources, { root, ref: "main", now: later });
    expect(snap.runs.find((r) => r.runId === "20261113-110000")?.unlisted).toEqual([
      expect.stringContaining("EACCES"),
    ]);
    const state = await buildState(snap, { staleAfterMs: 60_000, failureLimit: 25 });
    const view = state.runs.find((r) => r.runId === "20261113-110000");
    expect(view?.liveness).toBe("unknown");
    expect(view?.sessionsIncomplete).toContain("EACCES");
  });

  it("keeps a file that exists but cannot be read apart from a missing one", async () => {
    // A directory where a file belongs: readFile fails with EISDIR, a real I/O error.
    mkdirSync(join(root, ".ralph/logs/20261113-110000/sessions.tsv"));
    const snap = takeSnapshot(createSources(root), { root, ref: "main", now: NOW });
    expect(snap.runs[0]?.sessionsTsv).toEqual({ unreadable: expect.stringContaining("EISDIR") });
    const state = await buildState(snap, { staleAfterMs: 60_000, failureLimit: 25 });
    // Not "not merged yet": the per-process record must not stand in for the final one.
    expect(state.runs.find((r) => r.runId === "20261113-110000")?.sessionsIncomplete).toContain(
      "EISDIR",
    );
  });
});

// Git failures are reported with Git's own words. A ref Git cannot find is "not found when read",
// never "does not exist": a concurrent update can hide it for a moment, and nothing is retried.
describe("git failures", () => {
  const gitFailure = (status: number, stderr: string) =>
    Object.assign(new Error(`Command failed: git\n${stderr}`), {
      status,
      stderr: Buffer.from(stderr),
    });
  const failing = (command: string, error: Error, calls: string[][] = []): GitRunner => {
    const real = createGitRunner(root);
    return (args, input) => {
      calls.push([...args]);
      if (args[0] === command) {
        throw error;
      }
      return real(args, input);
    };
  };

  it("says a missing ref was not found when read, with Git's message", () => {
    const snap = takeSnapshot(createSources(root), { root, ref: "nope", now: NOW });
    const gap = snap.gaps.find((g) => g.source === "git ref nope");
    expect(gap?.reason).toContain("not found when read");
    expect(gap?.reason).toContain("fatal: Needed a single revision");
    expect(gap?.reason).not.toContain("does not exist");
  });

  it("reports a permission error as a Git failure, not as a missing ref", () => {
    const denied = gitFailure(128, "fatal: couldn't read .git/packed-refs: Permission denied\n");
    const snap = takeSnapshot(createSources(root, failing("rev-parse", denied)), {
      root,
      ref: "main",
      now: NOW,
    });
    const gap = snap.gaps.find((g) => g.source === "git ref main");
    expect(gap?.reason).toBe(
      "git rev-parse failed (exit 128): fatal: couldn't read .git/packed-refs: Permission denied",
    );
    expect(snap.commit).toBeNull();
  });

  it("surfaces a transient failure once, without a retry or a fallback, and recovers next time", () => {
    const calls: string[][] = [];
    const busy = gitFailure(128, "fatal: unable to read tree 0123abc\n");
    const first = takeSnapshot(createSources(root, failing("ls-tree", busy, calls)), {
      root,
      ref: "main",
      now: NOW,
    });
    expect(calls.filter((args) => args[0] === "ls-tree")).toHaveLength(2);
    expect(first.tickets).toBeNull();
    expect(first.register).toBeNull();
    expect(first.gaps).toContainEqual({
      source: "issues/ at main",
      reason: "git ls-tree failed (exit 128): fatal: unable to read tree 0123abc",
    });
    const second = takeSnapshot(createSources(root), { root, ref: "main", now: NOW });
    expect(second.tickets).toHaveLength(3);
  });

  it("reports a branch listing failure with Git's message", () => {
    const locked = gitFailure(
      128,
      "fatal: unable to read refs: Resource temporarily unavailable\n",
    );
    const snap = takeSnapshot(createSources(root, failing("for-each-ref", locked)), {
      root,
      ref: "main",
      now: NOW,
    });
    expect(snap.branches).toBeNull();
    expect(snap.gaps).toContainEqual({
      source: "git branches rejected/* and ralph/paused/*",
      reason:
        "git for-each-ref failed (exit 128): fatal: unable to read refs: Resource temporarily unavailable",
    });
  });

  it("reads tickets and the register from the one commit it resolved, even if main moves", () => {
    const before = git(root, "rev-parse", "main");
    // Another process (a merge, a fetch) advances main between the snapshot's reads.
    git(root, "switch", "--quiet", "main");
    write("issues/01-first.md", ticketText("01", "done"));
    write("docs/technical-debt.md", register());
    git(root, "commit", "--quiet", "-am", "advance");
    const after = git(root, "rev-parse", "main");
    git(root, "update-ref", "refs/heads/main", before);
    const real = createGitRunner(root);
    const moving: GitRunner = (args, input) => {
      const output = real(args, input);
      if (args[0] === "rev-parse") {
        git(root, "update-ref", "refs/heads/main", after);
      }
      return output;
    };
    const snap = takeSnapshot(createSources(root, moving), { root, ref: "main", now: NOW });
    expect(snap.commit).toBe(before);
    expect(snap.tickets?.find((t) => t.path === "issues/01-first.md")?.text).toContain(
      "**Status:** ready-for-agent",
    );
    expect(snap.register).toContain("### TD-001");
  });
});

describe("snapshot to state", () => {
  it("maps the real files end to end", async () => {
    const state = await buildState(
      takeSnapshot(createSources(root), { root, ref: "main", now: NOW }),
      { staleAfterMs: 60_000, failureLimit: 25 },
    );
    const byNumber = new Map(state.tickets?.map((t) => [t.number, t]));
    expect(byNumber.get("01")?.status).toBe("ready-for-agent");
    expect(byNumber.get("02")?.debt?.state).toBe("waiting");
    // Written moments ago, so the fixture's active run is live against the real clock.
    const live = await buildState(
      takeSnapshot(createSources(root), { root, ref: "main", now: Date.now() }),
      { staleAfterMs: 60_000, failureLimit: 25 },
    );
    expect(live.current.runs.map((r) => [r.runId, r.liveness])).toEqual([
      ["20261113-110500", "live"],
      ["20261113-110000", "live"],
    ]);
    expect(state.gaps).toContainEqual({
      source: ".ralph/state/01-first.pause",
      reason: "missing attempt, round, reason, run, ref",
    });
    expect(state.failures.map((f) => [f.kind, f.ticket])).toEqual(
      expect.arrayContaining([
        ["sandbox rejected", "02"],
        ["quarantined", "01"],
      ]),
    );
  });
});
