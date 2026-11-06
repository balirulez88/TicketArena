// Scenario tests for scripts/ralph-batch.mjs. Each test builds a host repo with a bare "GitHub"
// remote, the real ralph-loop.sh (ticket selection is its next_ticket) and the real batch
// script, then drives the batch with a stub runner and a stub CI. The runner stands in for one
// sandbox run of `ralph-loop.sh --ticket NN`: it merges the ticket the way finalize_slice does,
// or pauses, rejects, crashes, or kills the batch itself, as STUB_PLAN says per call.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRegister, renderRegister } from "./ralph-debt.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const RUNNER = `
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const ticket = process.argv[process.argv.indexOf("--ticket") + 1];
const log = process.env.STUB_RUNNER_LOG;
const calls = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter((l) => l === ticket).length : 0;
appendFileSync(log, ticket + "\\n");
const action = (JSON.parse(process.env.STUB_PLAN || "{}")[ticket] || [])[calls] || "merge";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const file = readdirSync("issues").find((name) => name.startsWith(ticket + "-"));
const slug = file.replace(/\\.md$/, "");
function merge() {
  git("switch", "--quiet", "-c", "slice/" + slug);
  const text = readFileSync("issues/" + file, "utf8").replace(/^\\*\\*Status:\\*\\* .*$/m, "**Status:** done");
  mkdirSync("issues/done", { recursive: true });
  writeFileSync("issues/done/" + file, text);
  git("rm", "--quiet", "issues/" + file);
  writeFileSync("feature-" + ticket + ".txt", "x\\n");
  const register = JSON.parse(process.env.STUB_REGISTER || "{}")[ticket];
  if (register) writeFileSync("docs/technical-debt.md", register);
  git("add", "-A");
  git("commit", "--quiet", "-m", "feat(slice-" + ticket + "): demo");
  git("switch", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "slice/" + slug, "-m", "Merge slice/" + slug + ": demo");
}
switch (action) {
  case "pause": process.exit(75);
  case "crash": process.exit(1);
  case "noop": process.exit(0);
  case "reject": {
    const path = "issues/" + file;
    writeFileSync(path, readFileSync(path, "utf8").replace(/^\\*\\*Status:\\*\\* .*$/m, "**Status:** blocked"));
    git("commit", "--quiet", "-am", "chore(issues): block " + path);
    process.exit(1);
  }
  case "reject-side": {
    // The host refused the base branch: the quarantine branch arrives, the blocked status does not.
    git("branch", "rejected/" + slug + "-run1");
    git("branch", "ralph/blocked-run1");
    process.exit(1);
  }
  case "half-merge": {
    // Archived without the merge commit: neither done nor absent.
    git("mv", "issues/" + file, "issues/done/" + file);
    git("commit", "--quiet", "-m", "chore(issues): archive " + file);
    process.exit(1);
  }
  case "merge-crash": merge(); process.exit(3);
  // The host refused the run's output (ralph-accept.mjs): nothing changed on the host.
  case "untrusted": process.exit(3);
  // Merged, then someone edits the host checkout before the batch pushes it.
  case "merge-dirty": merge(); writeFileSync("stray.txt", "x\\n"); process.exit(0);
  case "merge-kill": merge(); process.kill(process.ppid, "SIGKILL"); process.exit(0);
  default: merge();
}
`;

// Exit codes from STUB_CI (a JSON list), consumed one per call; 0 once it runs out.
const CI = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = process.env.STUB_CI_LOG;
const calls = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
appendFileSync(log, process.argv[2] + "\\n");
process.exit(JSON.parse(process.env.STUB_CI || "[]")[calls] ?? 0);
`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const ticketText = (number, title, blockedBy, status) =>
  `# ${number}: ${title}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n\n- [ ] works\n`;

function fixture(
  tickets = [
    ["01", "None (can start immediately)"],
    ["02", "None"],
    ["03", "None"],
  ],
  entries = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "ralph-batch-"));
  const github = join(dir, "github.git");
  const host = join(dir, "host");
  mkdirSync(join(host, "scripts"), { recursive: true });
  mkdirSync(join(host, "issues", "done"), { recursive: true });
  copyFileSync(join(source, "ralph-loop.sh"), join(host, "ralph-loop.sh"));
  copyFileSync(
    join(source, "scripts", "ralph-batch.mjs"),
    join(host, "scripts", "ralph-batch.mjs"),
  );
  copyFileSync(join(source, "scripts", "ralph-debt.mjs"), join(host, "scripts", "ralph-debt.mjs"));
  mkdirSync(join(host, "docs"), { recursive: true });
  writeFileSync(join(host, "docs", "technical-debt.md"), debtRegister(...entries));
  writeFileSync(join(host, ".gitignore"), ".ralph/\n");
  for (const [number, blockedBy, status = "ready-for-agent"] of tickets) {
    writeFileSync(
      join(host, "issues", `${number}-t${number}.md`),
      ticketText(number, `T${number}`, blockedBy, status),
    );
  }
  writeFileSync(join(dir, "runner.mjs"), RUNNER);
  writeFileSync(join(dir, "ci.mjs"), CI);
  spawnSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", github]);
  git(host, "init", "--quiet", "--initial-branch=main");
  git(host, "config", "core.autocrlf", "false");
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "init");
  git(host, "remote", "add", "origin", github);
  git(host, "push", "--quiet", "origin", "main");
  return { dir, host, github };
}

// --- Debt (ADR 0016) ---------------------------------------------------------------------------

const debtRegister = (...entries) =>
  renderRegister({
    preamble: "# Technical Debt Register\n\n",
    entries,
    trailer: "\n",
  });

/** A LOW finding as a review records it: untriaged, found by ticket `source`. */
const finding = (id, source, fields = {}) => ({
  id,
  title: `Finding ${id}`,
  fields: {
    Status: "OPEN",
    Severity: "LOW",
    Source: `ticket ${source} (\`${source}-t${source}\`)`,
    Evidence: "`.ralph/host-review/run/x.standards.json`",
    Components: "`feature.txt:1`",
    Problem: "p",
    Impact: "i",
    Justification: "Non-blocking under the merge policy.",
    Remediation: "r",
    ...fields,
  },
  history: ["2026-11-06: recorded"],
});
const TRIAGED = { Risk: "CORRECTNESS", Triage: "2026-11-06: triaged by a maintainer" };

/** A maintainer's commit on main, pushed: what a human's triage looks like to the batch. */
function triage(fx, id, fields) {
  const path = join(fx.host, "docs", "technical-debt.md");
  const register = parseRegister(readFileSync(path, "utf8"));
  const entries = register.entries.map((e) =>
    e.id === id
      ? { ...e, fields: { ...e.fields, ...fields }, history: [...e.history, "2026-11-06: triaged"] }
      : e,
  );
  writeFileSync(path, renderRegister({ ...register, entries }));
  git(fx.host, "commit", "--quiet", "-am", `chore(debt): triage ${id}`);
  git(fx.host, "push", "--quiet", "origin", "main");
}

function batch(
  fx,
  args,
  {
    plan = {},
    ci = [],
    debt = {},
    entry = ["node", join(fx.host, "scripts", "ralph-batch.mjs")],
  } = {},
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("RALPH_")),
  );
  const [command, ...prefix] = entry;
  const result = spawnSync(command, [...prefix, ...args], {
    cwd: fx.host,
    encoding: "utf8",
    env: {
      ...env,
      ...identity,
      RALPH_BATCH_RUNNER: `node ${join(fx.dir, "runner.mjs")}`,
      RALPH_BATCH_CI: `node ${join(fx.dir, "ci.mjs")}`,
      STUB_PLAN: JSON.stringify(plan),
      STUB_REGISTER: JSON.stringify(debt),
      STUB_CI: JSON.stringify(ci),
      STUB_RUNNER_LOG: join(fx.dir, "runner.log"),
      STUB_CI_LOG: join(fx.dir, "ci.log"),
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// The real scripts/sandbox.sh, committed and pushed like the rest of the fixture.
function withSandbox(fx) {
  copyFileSync(join(source, "scripts", "sandbox.sh"), join(fx.host, "scripts", "sandbox.sh"));
  git(fx.host, "add", "-A");
  git(fx.host, "commit", "--quiet", "-m", "add sandbox.sh");
  git(fx.host, "push", "--quiet", "origin", "main");
  return ["bash", join(fx.host, "scripts", "sandbox.sh")];
}

const lines = (file) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const runnerCalls = (fx) => lines(join(fx.dir, "runner.log"));
const ciCalls = (fx) => lines(join(fx.dir, "ci.log"));
const state = (fx) =>
  JSON.parse(readFileSync(join(fx.host, ".ralph", "batch", "state.json"), "utf8"));
const mergedCount = (fx, number) =>
  git(fx.host, "log", "main", "--merges", "--format=%s")
    .split("\n")
    .filter((s) => s.startsWith(`Merge slice/${number}-`)).length;
const onGithub = (fx) => git(fx.github, "rev-parse", "main");

describe("bounded batch", () => {
  it("stops at the batch limit with every merged ticket pushed and CI-verified", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "2"]);
    assert.equal(code, 0, out);
    assert.match(out, /FINISHED: batch-limit/);
    assert.deepEqual(runnerCalls(fx), ["01", "02"]);
    assert.equal(mergedCount(fx, "03"), 0);
    assert.equal(onGithub(fx), git(fx.host, "rev-parse", "main"));
    // The base before ticket 01, then each merge commit: CI gates every next step.
    assert.equal(ciCalls(fx).length, 3);
    assert.deepEqual(
      state(fx).tickets.map((t) => [t.number, t.stage, t.ci]),
      [
        ["01", "verified", "passed"],
        ["02", "verified", "passed"],
      ],
    );
  });

  it("reports when no ticket is eligible", () => {
    const fx = fixture([["01", "None", "done"]]);
    const { code, out } = batch(fx, ["--max-tickets", "3"]);
    assert.equal(code, 0, out);
    assert.match(out, /FINISHED: no-eligible-ticket/);
    assert.deepEqual(runnerCalls(fx), []);
  });

  it("stops on an unresolved dependency, naming the waiting tickets", () => {
    const fx = fixture([
      ["01", "None", "blocked"],
      ["02", "01"],
    ]);
    const { code, out } = batch(fx, ["--max-tickets", "3"]);
    assert.equal(code, 2, out);
    assert.match(out, /unresolved-dependency: .*issues\/02-t02\.md/);
    assert.deepEqual(runnerCalls(fx), []);
  });

  it("never starts the next ticket before CI passes, and a failed CI ends the batch", () => {
    const fx = fixture();
    const first = batch(fx, ["--max-tickets", "3"], { ci: [0, 1] });
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, /STOPPED: ci-failed/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
    // Not silently resumable: the failure must be dealt with and a new batch started explicitly.
    const again = batch(fx, ["--max-tickets", "3"]);
    assert.equal(again.code, 1);
    assert.match(
      again.out,
      /stopped on ci-failed; resolve that, then start a new batch with --new/,
    );
    assert.deepEqual(runnerCalls(fx), ["01"]);
  });

  it("refuses to start on a base that CI has not passed", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "1"], { ci: [1] });
    assert.equal(code, 1, out);
    assert.match(out, /base-not-verified: CI failed on main/);
    assert.deepEqual(runnerCalls(fx), []);
  });

  it("refuses to start on unpushed commits", () => {
    const fx = fixture();
    git(fx.host, "commit", "--quiet", "--allow-empty", "-m", "local only");
    const { code, out } = batch(fx, ["--max-tickets", "1"]);
    assert.equal(code, 1, out);
    assert.match(out, /base-not-verified: .*is not what origin has/);
    assert.deepEqual(runnerCalls(fx), []);
  });

  it("stops on a rejected ticket and never skips it", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "3"], { plan: { "01": ["reject"] } });
    assert.equal(code, 1, out);
    assert.match(out, /STOPPED: rejected: ticket 01 was rejected/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
    assert.equal(state(fx).tickets[0].stage, "rejected");
  });

  it("stops finally when the host refuses a run's output as untrusted, and pushes nothing", () => {
    const fx = fixture();
    const before = onGithub(fx);
    const { code, out } = batch(fx, ["--max-tickets", "3"], { plan: { "01": ["untrusted"] } });
    assert.equal(code, 1, out);
    assert.match(out, /STOPPED: untrusted-result: the host refused ticket 01's sandbox output/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
    assert.equal(state(fx).tickets[0].stage, "untrusted");
    assert.equal(onGithub(fx), before);
    // Never retried silently: a human looks at the refused output first.
    const again = batch(fx, ["--max-tickets", "3"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /stopped on untrusted-result; resolve that/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
  });

  it("pushes nothing when the checkout changed after a merge, and resumes once restored", () => {
    const fx = fixture();
    const before = onGithub(fx);
    const first = batch(fx, ["--max-tickets", "1"], { plan: { "01": ["merge-dirty"] } });
    assert.equal(first.code, 1, first.out);
    assert.match(
      first.out,
      /STOPPED \(resumable\): checkout-changed: the working tree is not clean/,
    );
    assert.equal(onGithub(fx), before);
    rmSync(join(fx.host, "stray.txt"));
    const again = batch(fx, ["--max-tickets", "1"]);
    assert.equal(again.code, 0, again.out);
    assert.equal(onGithub(fx), git(fx.host, "rev-parse", "main"));
    assert.deepEqual(runnerCalls(fx), ["01"]);
  });

  it("a rejection whose blocked status reached only a side branch is still a rejection", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "3"], { plan: { "01": ["reject-side"] } });
    assert.equal(code, 1, out);
    assert.match(
      out,
      /STOPPED: rejected: ticket 01 was rejected and is blocked on a ralph\/blocked-\* side branch/,
    );
    assert.deepEqual(runnerCalls(fx), ["01"]);
    assert.equal(state(fx).tickets[0].stage, "rejected");
  });

  it("a half-merged ticket blocks the batch, and blocks it again on the rerun", () => {
    const fx = fixture();
    const first = batch(fx, ["--max-tickets", "3"], { plan: { "01": ["half-merge"] } });
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, /STOPPED \(resumable\): ambiguous-merge: ticket 01 is half-merged/);
    const rerun = batch(fx, ["--max-tickets", "3"]);
    assert.equal(rerun.code, 1, rerun.out);
    assert.match(rerun.out, /STOPPED \(resumable\): ambiguous-merge: ticket 01 is half-merged/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
  });

  it("treats 'success' without a merge as ambiguous, never as done", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "1"], { plan: { "01": ["noop"] } });
    assert.equal(code, 1, out);
    assert.match(out, /ambiguous-merge: the runner reported success, but ticket 01 is not merged/);
    assert.equal(state(fx).status, "running");
  });
});

describe("resume and idempotency", () => {
  it("resumes a paused ticket with the stored limit and continues from it", () => {
    const fx = fixture();
    const paused = batch(fx, ["--max-tickets", "2"], { plan: { "01": ["pause"] } });
    assert.equal(paused.code, 75, paused.out);
    assert.match(paused.out, /STOPPED \(resumable\): paused/);
    // The limit is the batch's, not the command line's.
    const conflicting = batch(fx, ["--max-tickets", "5"]);
    assert.equal(conflicting.code, 1);
    assert.match(conflicting.out, /runs with --max-tickets 2; resume it with that value or none/);
    const resumed = batch(fx, []);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /resuming batch .* \(max 2 ticket\(s\)\)/);
    assert.deepEqual(runnerCalls(fx), ["01", "01", "02"]);
    assert.equal(mergedCount(fx, "01"), 1);
    assert.equal(mergedCount(fx, "03"), 0);
  });

  it("a batch killed right after a merge resumes at the push, never re-running the ticket", () => {
    const fx = fixture();
    const killed = batch(fx, ["--max-tickets", "2"], { plan: { "01": ["merge-kill"] } });
    assert.notEqual(killed.code, 0);
    assert.equal(state(fx).tickets[0].stage, "running");
    // The kill left the lock: a human confirms nothing runs and removes it.
    const locked = batch(fx, []);
    assert.equal(locked.code, 1);
    assert.match(locked.out, /no longer running\. If no batch is running, remove that directory/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
    spawnSync("rm", ["-rf", join(fx.host, ".ralph", "batch", "lock")]);
    const resumed = batch(fx, []);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(
      resumed.out,
      /ticket 01 is already merged on main; continuing from there, never again/,
    );
    assert.deepEqual(runnerCalls(fx), ["01", "02"]);
    assert.equal(mergedCount(fx, "01"), 1);
    assert.equal(onGithub(fx), git(fx.host, "rev-parse", "main"));
  });

  it("a runner that fails after merging is judged by the repository", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "1"], { plan: { "01": ["merge-crash"] } });
    assert.equal(code, 0, out);
    assert.match(out, /the runner exited 3, but main has ticket 01 merged/);
    assert.equal(mergedCount(fx, "01"), 1);
  });

  it("an unconfirmed CI stops resumably and is checked again on the rerun", () => {
    const fx = fixture();
    const first = batch(fx, ["--max-tickets", "2"], { ci: [0, 2] });
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, /STOPPED \(resumable\): ci-unverified/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
    const resumed = batch(fx, []);
    assert.equal(resumed.code, 0, resumed.out);
    assert.deepEqual(runnerCalls(fx), ["01", "02"]);
    const sha01 = state(fx).tickets[0].sha;
    assert.equal(ciCalls(fx).filter((sha) => sha === sha01).length, 2);
  });

  it("a crashed runner that neither merged nor rejected stops resumably and reruns the ticket", () => {
    const fx = fixture();
    const first = batch(fx, ["--max-tickets", "1"], { plan: { "01": ["crash"] } });
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, /runner-failed/);
    const resumed = batch(fx, []);
    assert.equal(resumed.code, 0, resumed.out);
    assert.deepEqual(runnerCalls(fx), ["01", "01"]);
    assert.equal(mergedCount(fx, "01"), 1);
  });
});

describe("one batch at a time", () => {
  it("refuses while another batch holds the lock", () => {
    const fx = fixture();
    const lock = join(fx.host, ".ralph", "batch", "lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, host: "elsewhere" }),
    );
    const { code, out } = batch(fx, ["--max-tickets", "1"]);
    assert.equal(code, 1);
    assert.match(out, /another Ralph batch is running/);
    assert.deepEqual(runnerCalls(fx), []);
    assert.equal(existsSync(lock), true, "the other batch's lock is left alone");
  });

  it("releases its lock when it stops", () => {
    const fx = fixture();
    batch(fx, ["--max-tickets", "1"]);
    assert.equal(existsSync(join(fx.host, ".ralph", "batch", "lock")), false);
  });

  it("a plain sandbox run refuses while a batch holds the lock (before Docker is needed)", () => {
    const fx = fixture();
    const sandbox = { entry: withSandbox(fx) };
    mkdirSync(join(fx.host, ".ralph", "batch", "lock"), { recursive: true });
    const { code, out } = batch(fx, ["--once"], sandbox);
    assert.equal(code, 1, out);
    assert.match(out, /a Ralph batch holds .*lock/);
  });
});

describe("entry points", () => {
  it("`sandbox.sh --max-tickets N` runs the batch on the host", () => {
    const fx = fixture();
    const sandbox = { entry: withSandbox(fx) };
    const { code, out } = batch(fx, ["--max-tickets", "1"], sandbox);
    assert.equal(code, 0, out);
    assert.match(out, /FINISHED: batch-limit: 1 of 1/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
  });

  it("`ralph-loop.sh --max-tickets N` points to the batch instead of running", () => {
    const fx = fixture();
    const { code, out } = batch(fx, ["--max-tickets", "2"], {
      entry: ["bash", join(fx.host, "ralph-loop.sh")],
    });
    assert.notEqual(code, 0, out);
    assert.match(out, /use 'pnpm sandbox --max-tickets N'/);
    assert.deepEqual(runnerCalls(fx), []);
  });
});

describe("bounded batch: the debt gate (ADR 0016)", () => {
  it("runs independent tickets first, stops needs-triage before one that builds on an untriaged finding, and resumes", () => {
    const fx = fixture([
      ["01", "None"],
      ["02", "01"],
      ["03", "None"],
    ]);
    // Ticket 01's review leaves an untriaged LOW finding; ticket 02 builds on 01.
    const first = batch(fx, ["--max-tickets", "3"], {
      debt: { "01": debtRegister(finding("TD-001", "01")) },
    });
    assert.equal(first.code, 4, first.out);
    assert.match(
      first.out,
      /STOPPED \(resumable\): needs-triage: .*02-t02\.md: TD-001 is untriaged and ticket 02 builds on ticket 01/,
    );
    // The independent ticket 03 proceeds; ticket 02 never runs on risk nobody has judged.
    assert.deepEqual(runnerCalls(fx), ["01", "03"]);
    assert.equal(state(fx).status, "running");
    // A human triages it as deferred; the same batch resumes with its own limit.
    triage(fx, "TD-001", TRIAGED);
    const again = batch(fx, []);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /FINISHED: batch-limit/);
    assert.deepEqual(runnerCalls(fx), ["01", "03", "02"]);
  });

  it("lets an independent ticket proceed past an untriaged LOW finding it does not build on", () => {
    const fx = fixture([
      ["01", "None"],
      ["02", "None"],
    ]);
    const { code, out } = batch(fx, ["--max-tickets", "2"], {
      debt: { "01": debtRegister(finding("TD-001", "01")) },
    });
    assert.equal(code, 0, out);
    assert.deepEqual(runnerCalls(fx), ["01", "02"]);
  });

  it("lets every ticket proceed past a triaged LOW correctness finding that blocks nothing", () => {
    const fx = fixture(
      [
        ["01", "None"],
        ["02", "01"],
      ],
      [finding("TD-001", "01", TRIAGED)],
    );
    const { code, out } = batch(fx, ["--max-tickets", "2"]);
    assert.equal(code, 0, out);
    assert.deepEqual(runnerCalls(fx), ["01", "02"]);
  });

  it("never runs a ticket that triaged debt blocks; independent tickets run instead", () => {
    // TD-001 blocks ticket 01 until ticket 03 resolves it.
    const blocking = finding("TD-001", "02", {
      ...TRIAGED,
      Status: "PLANNED",
      Target: "ticket 03",
      Blocks: "01",
    });
    const fx = fixture(
      [
        ["01", "None"],
        ["02", "None"],
        ["03", "None", "blocked"],
      ],
      [blocking],
    );
    const { code, out } = batch(fx, ["--max-tickets", "3"]);
    assert.equal(code, 2, out);
    assert.match(
      out,
      /unresolved-dependency: .*01-t01\.md \(debt: TD-001 \(CORRECTNESS\) until ticket 03 resolves it\)/,
    );
    // Ticket 01 never runs while TD-001 is unresolved: it cannot bypass the debt.
    assert.deepEqual(runnerCalls(fx), ["02"]);
  });

  it("stops before any ticket while a MEDIUM finding is untriaged", () => {
    const fx = fixture(undefined, [finding("TD-001", "01", { Severity: "MEDIUM" })]);
    const { code, out } = batch(fx, ["--max-tickets", "1"]);
    assert.equal(code, 4, out);
    assert.match(out, /needs-triage: .*01-t01\.md: TD-001 \(MEDIUM\) is untriaged/);
    assert.deepEqual(runnerCalls(fx), []);
  });

  it("stops a paused ticket that triaged debt now blocks as a dependency, not as triage", () => {
    const fx = fixture([
      ["01", "None"],
      ["02", "None", "blocked"],
    ]);
    const first = batch(fx, ["--max-tickets", "1"], { plan: { "01": ["pause"] } });
    assert.equal(first.code, 75, first.out);
    // Meanwhile a maintainer decides ticket 01 relies on a fix ticket 02 owns.
    writeFileSync(
      join(fx.host, "docs", "technical-debt.md"),
      debtRegister(
        finding("TD-001", "01", {
          ...TRIAGED,
          Status: "PLANNED",
          Target: "ticket 02",
          Blocks: "01",
        }),
      ),
    );
    git(fx.host, "commit", "--quiet", "-am", "chore(debt): TD-001 blocks ticket 01");
    git(fx.host, "push", "--quiet", "origin", "main");
    const held = batch(fx, []);
    assert.equal(held.code, 2, held.out);
    assert.match(held.out, /unresolved-dependency: ticket 01 waits on unresolved debt: TD-001/);
    assert.deepEqual(runnerCalls(fx), ["01"]);
  });

  it("does not resume a paused ticket that new debt now holds up, until it is triaged", () => {
    const fx = fixture([["01", "None"]]);
    const first = batch(fx, ["--max-tickets", "1"], { plan: { "01": ["pause"] } });
    assert.equal(first.code, 75, first.out);
    // Meanwhile a maintainer records a MEDIUM finding nobody has triaged yet.
    writeFileSync(
      join(fx.host, "docs", "technical-debt.md"),
      debtRegister(finding("TD-001", "01", { Severity: "MEDIUM" })),
    );
    git(fx.host, "commit", "--quiet", "-am", "chore(debt): record TD-001");
    git(fx.host, "push", "--quiet", "origin", "main");
    const held = batch(fx, []);
    assert.equal(held.code, 4, held.out);
    assert.match(
      held.out,
      /ticket 01 is needs-triage on unresolved debt: TD-001 \(MEDIUM\) is untriaged/,
    );
    assert.deepEqual(runnerCalls(fx), ["01"]);
    triage(fx, "TD-001", { ...TRIAGED, Status: "PLANNED", Target: "ticket 01" });
    const resumed = batch(fx, []);
    assert.equal(resumed.code, 0, resumed.out);
    assert.deepEqual(runnerCalls(fx), ["01", "01"]);
    assert.equal(mergedCount(fx, "01"), 1);
  });
});
