// Tests for scripts/ralph-quarantine.mjs (TD-059 WS2): exact resolution of quarantined candidates,
// the host's rejection records (with the narrow legacy-provenance exception, D1), read-only
// inspection, and the recovery hold that keeps an unreconciled rejection from being run again
// (D2). Every test builds its own throwaway repository; no real rejected work is touched.

import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostRejection,
  inspectRef,
  listQuarantine,
  placeRecoveryHold,
  QuarantineRefusal,
  recoveryHoldState,
  recoveryHolds,
  releaseRecoveryHold,
  removeReplayRef,
  resolveCandidate,
} from "./ralph-quarantine.mjs";

const source = fileURLToPath(new URL(".", import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const SUFFIX = "01-demo-20261108-102624";
const NEW = `refs/ralph/rejected/${SUFFIX}`;
const LEGACY = `refs/heads/rejected/${SUFFIX}`;
const TICKET = `# 01: Demo ticket\n\n**Status:** ready-for-agent\n\n- [ ] works\n`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const write = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

/** The host's record of a host-review rejection, exactly as ralph-accept.mjs writes it. */
const recordBody = (slug, sha, where) =>
  `The host's isolated Standards and Spec review of slice/${slug} (${sha.slice(0, 12)}) was blocked, so the slice did not merge. It is preserved on ${where}. Report: .ralph/host-review/run/${slug}/review.md`;

function record(host, where, sha, { slug = "01-demo", subject } = {}) {
  write(host, "issues/01-demo.md", TICKET.replace("ready-for-agent", "blocked"));
  git(host, "add", "-A");
  git(
    host,
    "commit",
    "--quiet",
    "-m",
    subject ?? `chore(issues): block issues/${slug}.md after the host review`,
    "-m",
    recordBody(slug, sha, where),
  );
}

/** A host with one candidate commit (not on any ref yet) and main. */
function repo({ candidate } = {}) {
  const host = mkdtempSync(join(tmpdir(), "ralph-quarantine-"));
  git(host, "init", "--quiet", "--initial-branch=main");
  git(host, "config", "core.autocrlf", "false");
  write(host, "issues/01-demo.md", TICKET);
  write(host, "app.txt", "v1\n");
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "init");
  git(host, "switch", "--quiet", "-c", "work");
  write(host, "packages/demo/feature.ts", "export const feature = 1;\n");
  write(host, "packages/demo/feature.test.ts", "test('feature', () => {});\n");
  candidate?.(host);
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "feat(slice-01): Demo ticket");
  const tip = git(host, "rev-parse", "HEAD");
  git(host, "switch", "--quiet", "main");
  git(host, "branch", "--quiet", "-D", "work");
  // The command line works on the repository it is installed in, as on the host.
  for (const script of ["ralph-quarantine.mjs", "ralph-push-inspect.mjs", "ralph-artifacts.mjs"]) {
    mkdirSync(join(host, "scripts"), { recursive: true });
    copyFileSync(join(source, script), join(host, "scripts", script));
  }
  return { host, tip };
}

const refuses = (fn, pattern) =>
  assert.throws(fn, (error) => error instanceof QuarantineRefusal && pattern.test(error.message));

/** Everything inspection must leave alone: refs, HEAD, index, working tree, reflogs. */
function snapshot(host) {
  const index = join(host, ".git", "index");
  return {
    refs: git(host, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: git(host, "rev-parse", "HEAD"),
    status: git(host, "status", "--porcelain", "--ignored"),
    index: existsSync(index) ? readFileSync(index).toString("base64") : "",
    reflog: git(host, "reflog", "--all", "--format=%H %gs"),
  };
}

describe("ralph-quarantine: exact candidate resolution", () => {
  it("resolves the new quarantine namespace by its full name", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    const found = resolveCandidate(host, NEW);
    assert.equal(found.ref, NEW);
    assert.equal(found.sha, tip);
    assert.equal(found.namespace, "quarantine");
    assert.equal(found.slug, "01-demo");
    assert.equal(found.suffix, SUFFIX);
  });

  it("resolves a legacy rejected/* branch by its full name", () => {
    const { host, tip } = repo();
    git(host, "update-ref", LEGACY, tip);
    const found = resolveCandidate(host, LEGACY);
    assert.equal(found.ref, LEGACY);
    assert.equal(found.namespace, "legacy");
  });

  it("takes rejected/<name> only as an alias for the two quarantine namespaces", () => {
    const { host, tip } = repo();
    git(host, "update-ref", LEGACY, tip);
    assert.equal(resolveCandidate(host, `rejected/${SUFFIX}`).ref, LEGACY);
    git(host, "update-ref", NEW, tip);
    // Both at the same commit (a migration that has not removed the branch yet): one identity,
    // and the new namespace is the one named.
    assert.equal(resolveCandidate(host, `rejected/${SUFFIX}`).ref, NEW);
  });

  it("refuses conflicting identities in the two namespaces, whatever form names it", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    git(host, "update-ref", LEGACY, git(host, "rev-parse", "main"));
    for (const name of [NEW, LEGACY, `rejected/${SUFFIX}`]) {
      refuses(() => resolveCandidate(host, name), /conflicting/);
    }
  });

  it("never guesses: a tag or remote-tracking ref of the same short name is not a candidate", () => {
    const { host, tip } = repo();
    git(host, "update-ref", `refs/tags/rejected/${SUFFIX}`, tip);
    git(host, "update-ref", `refs/remotes/origin/rejected/${SUFFIX}`, tip);
    refuses(() => resolveCandidate(host, `rejected/${SUFFIX}`), /no quarantine ref/);
  });

  for (const [name, pattern] of [
    [`refs/ralph/incoming/20261108-102624-1/rejected/${SUFFIX}`, /incoming .* never replayable/],
    [`refs/remotes/origin/rejected/${SUFFIX}`, /published .* never replayable/],
    ["refs/heads/main", /not in a quarantine namespace/],
    ["main", /not in a quarantine namespace/],
    [`refs/ralph/replay/replay-1-1/main`, /not in a quarantine namespace/],
    [`refs/tags/rejected/${SUFFIX}`, /not in a quarantine namespace/],
  ]) {
    it(`refuses a candidate outside the quarantine namespaces: ${name}`, () => {
      const { host, tip } = repo();
      git(host, "update-ref", name.startsWith("refs/") ? name : `refs/heads/${name}`, tip);
      refuses(() => resolveCandidate(host, name), pattern);
    });
  }

  for (const name of [
    "rejected/01-demo",
    "rejected/01-Demo-20261108-102624",
    "rejected/1-demo-20261108-102624",
    `rejected/${SUFFIX}/extra`,
    `rejected/../${SUFFIX}`,
    `rejected/${SUFFIX}.lock`,
    "rejected/01-démo-20261108-102624",
    `refs/ralph/rejected/${SUFFIX} `,
    "",
  ]) {
    it(`refuses a malformed name: ${JSON.stringify(name)}`, () => {
      const { host } = repo();
      refuses(() => resolveCandidate(host, name), /not a valid quarantine name/);
    });
  }

  it("reports a missing candidate clearly", () => {
    const { host } = repo();
    refuses(() => resolveCandidate(host, NEW), /no quarantine ref .*01-demo-20261108-102624/);
  });

  it("refuses a symbolic ref", () => {
    const { host } = repo();
    git(host, "symbolic-ref", NEW, "refs/heads/main");
    refuses(() => resolveCandidate(host, NEW), /symbolic/);
  });

  it("refuses a symbolic twin in the other namespace", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    git(host, "symbolic-ref", LEGACY, "refs/heads/main");
    refuses(() => resolveCandidate(host, NEW), /symbolic/);
  });

  it("refuses a ref to a blob or an annotated tag", () => {
    const { host, tip } = repo();
    const blob = git(host, "rev-parse", `${tip}:app.txt`);
    git(host, "update-ref", NEW, blob);
    refuses(() => resolveCandidate(host, NEW), /not a commit/);
    git(host, "tag", "--annotate", "-m", "t", "t1", tip);
    git(host, "update-ref", NEW, git(host, "rev-parse", "refs/tags/t1"));
    refuses(() => resolveCandidate(host, NEW), /not a commit/);
  });
});

describe("ralph-quarantine: the host's rejection record", () => {
  const base = (host) => git(host, "rev-parse", "main");

  it("accepts the current record for a candidate in the new namespace", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    record(host, NEW, tip);
    const found = hostRejection(host, { base: base(host), candidate: resolveCandidate(host, NEW) });
    assert.equal(found.form, "current");
    assert.equal(found.commit, base(host));
  });

  it("accepts a legacy record for the legacy branch it names", () => {
    const { host, tip } = repo();
    git(host, "update-ref", LEGACY, tip);
    record(host, `rejected/${SUFFIX}`, tip);
    const found = hostRejection(host, {
      base: base(host),
      candidate: resolveCandidate(host, LEGACY),
    });
    assert.equal(found.form, "legacy");
  });

  it("accepts a legacy record for the same candidate migrated to the new namespace (D1)", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    record(host, `rejected/${SUFFIX}`, tip);
    const found = hostRejection(host, { base: base(host), candidate: resolveCandidate(host, NEW) });
    assert.equal(found.form, "legacy-migrated");
  });

  it("does not let a current record authorize a branch under refs/heads/", () => {
    const { host, tip } = repo();
    git(host, "update-ref", LEGACY, tip);
    record(host, NEW, tip);
    refuses(
      () => hostRejection(host, { base: base(host), candidate: resolveCandidate(host, LEGACY) }),
      /no host-review rejection/,
    );
  });

  for (const [what, where] of [
    ["a longer suffix", `rejected/${SUFFIX}5`],
    ["a suffix with more after it", `rejected/${SUFFIX}-x`],
    ["another ticket's suffix", "rejected/02-demo-20261108-102624"],
    ["a prefix of the name", "rejected/01-demo-20261108"],
    ["the name inside another namespace", `refs/heads/other/rejected/${SUFFIX}`],
  ]) {
    it(`never matches a record by substring: ${what}`, () => {
      const { host, tip } = repo();
      git(host, "update-ref", NEW, tip);
      record(host, where, tip);
      refuses(
        () => hostRejection(host, { base: base(host), candidate: resolveCandidate(host, NEW) }),
        /no host-review rejection/,
      );
    });
  }

  it("refuses a legacy record for an unrelated candidate at the same commit", () => {
    const { host, tip } = repo();
    const other = "refs/ralph/rejected/01-demo-20261109-090000";
    git(host, "update-ref", other, tip);
    record(host, `rejected/${SUFFIX}`, tip);
    refuses(
      () => hostRejection(host, { base: base(host), candidate: resolveCandidate(host, other) }),
      /no host-review rejection/,
    );
  });

  it("refuses a record whose 12-character commit identity differs", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    record(host, `rejected/${SUFFIX}`, "0".repeat(40));
    refuses(
      () => hostRejection(host, { base: base(host), candidate: resolveCandidate(host, NEW) }),
      /no host-review rejection/,
    );
  });

  it("refuses a record under another subject, or off the first-parent history", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    record(host, NEW, tip, { subject: "chore(issues): block issues/01-demo.md (forged)" });
    refuses(
      () => hostRejection(host, { base: base(host), candidate: resolveCandidate(host, NEW) }),
      /no host-review rejection/,
    );
    const { host: other, tip: otherTip } = repo();
    git(other, "update-ref", NEW, otherTip);
    git(other, "switch", "--quiet", "-c", "side");
    record(other, NEW, otherTip);
    git(other, "switch", "--quiet", "main");
    write(other, "app.txt", "v2\n");
    git(other, "commit", "--quiet", "-am", "main moves");
    git(other, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
    refuses(
      () => hostRejection(other, { base: base(other), candidate: resolveCandidate(other, NEW) }),
      /no host-review rejection/,
    );
  });

  it("does not accept a record whose body carries the claim after other text", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    write(host, "issues/01-demo.md", TICKET.replace("ready-for-agent", "blocked"));
    git(host, "add", "-A");
    git(
      host,
      "commit",
      "--quiet",
      "-m",
      "chore(issues): block issues/01-demo.md after the host review",
      "-m",
      `Note. ${recordBody("01-demo", tip, NEW)}`,
    );
    refuses(
      () => hostRejection(host, { base: base(host), candidate: resolveCandidate(host, NEW) }),
      /no host-review rejection/,
    );
  });
});

describe("ralph-quarantine: read-only inspection", () => {
  function populated() {
    const { host, tip } = repo({
      candidate: (dir) => {
        write(dir, ".github/workflows/evil.yml", "on: push\n");
        write(dir, ".env", "TOKEN=abcdefghijklmnop\n");
        write(dir, "scripts/evil.mjs", "process.exit(0);\n");
        write(dir, ".gitattributes", "*.ts diff=evil\n");
      },
    });
    git(host, "update-ref", NEW, tip);
    record(host, NEW, tip);
    git(host, "update-ref", LEGACY, tip);
    git(host, "update-ref", `refs/ralph/incoming/20261108-102624-1/rejected/${SUFFIX}`, tip);
    git(host, "update-ref", `refs/remotes/origin/rejected/${SUFFIX}`, tip);
    // Drivers that would run if anything let Git invoke them.
    const marker = join(host, "driver-ran");
    const driver = join(host, "driver.sh");
    writeFileSync(driver, `#!/bin/sh\ntouch '${marker.replace(/\\/g, "/")}'\ncat "$1"\n`);
    git(host, "config", "diff.external", `sh '${driver.replace(/\\/g, "/")}'`);
    git(host, "config", "diff.evil.textconv", `sh '${driver.replace(/\\/g, "/")}'`);
    git(host, "config", "diff.evil.command", `sh '${driver.replace(/\\/g, "/")}'`);
    write(host, ".gitattributes", "* diff=evil\n");
    return { host, tip, marker };
  }

  it("lists every kind distinctly and offers only quarantine refs for replay", () => {
    const { host, tip, marker } = populated();
    const before = snapshot(host);
    const rows = listQuarantine(host, { base: "main" });
    const kind = (ref) => rows.find((row) => row.ref === ref);
    assert.equal(kind(NEW).kind, "quarantine");
    assert.equal(kind(NEW).eligible, true);
    assert.equal(kind(LEGACY).kind, "legacy-branch");
    const incoming = kind(`refs/ralph/incoming/20261108-102624-1/rejected/${SUFFIX}`);
    assert.equal(incoming.kind, "incoming");
    assert.equal(incoming.eligible, false, "incoming work is never offered for replay");
    assert.match(incoming.why, /never replayable/);
    const published = kind(`refs/remotes/origin/rejected/${SUFFIX}`);
    assert.equal(published.kind, "published-copy");
    assert.equal(published.eligible, false);
    for (const row of rows) {
      assert.equal(row.sha, tip);
      assert.equal(row.ticket, "01");
    }
    assert.deepEqual(snapshot(host), before);
    assert.equal(existsSync(marker), false, "no diff driver ran");
  });

  it("explains why a candidate in the quarantine namespace is not eligible", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    const [row] = listQuarantine(host, { base: "main" });
    assert.equal(row.eligible, false);
    assert.match(row.why, /no host-review rejection/);
  });

  it("inspects a candidate without checking it out, running drivers or moving refs", async () => {
    const { host, tip, marker } = populated();
    const before = snapshot(host);
    const report = await inspectRef(host, NEW, { base: "main" });
    assert.equal(report.ref, NEW);
    assert.equal(report.sha, tip);
    assert.equal(report.kind, "quarantine");
    assert.equal(report.ticket, "01");
    assert.equal(report.subject, "feat(slice-01): Demo ticket");
    assert.match(report.date, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(report.eligible, true);
    assert.equal(report.evidence.form, "current");
    assert.ok(report.paths.some((p) => p.path === ".github/workflows/evil.yml"));
    const warned = report.warnings.join("\n");
    assert.match(warned, /\.github\/workflows\/evil\.yml/);
    assert.match(warned, /\.env: env file/);
    assert.match(warned, /scripts\/evil\.mjs: protected/);
    assert.match(warned, /credential assignment/);
    assert.deepEqual(snapshot(host), before);
    assert.equal(existsSync(marker), false, "no diff driver ran");
  });

  it("names an incoming or published ref for what it is when inspected", async () => {
    const { host } = populated();
    const report = await inspectRef(host, `refs/remotes/origin/rejected/${SUFFIX}`, {
      base: "main",
    });
    assert.equal(report.kind, "published-copy");
    assert.equal(report.eligible, false);
  });

  it("exits non-zero naming the problem for a ref it cannot inspect", () => {
    const { host } = repo();
    const result = spawnSync(
      process.execPath,
      [join(host, "scripts", "ralph-quarantine.mjs"), "inspect", "refs/heads/main"],
      {
        cwd: host,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a quarantined, incoming or published rejected ref/);
  });

  it("prints one inspection from the command line, read-only", () => {
    const { host, tip, marker } = populated();
    const before = snapshot(host);
    const result = spawnSync(
      process.execPath,
      [join(host, "scripts", "ralph-quarantine.mjs"), "inspect", NEW],
      { cwd: host, encoding: "utf8", env: { ...process.env, RALPH_BASE_BRANCH: "main" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`quarantine\\s+${NEW} ${tip.slice(0, 12)} .*replayable`),
    );
    assert.match(result.stdout, /host rejection: [0-9a-f]{40} \(current, recorded as /);
    assert.match(result.stdout, /^ {2}A \.github\/workflows\/evil\.yml$/m);
    assert.match(result.stdout, /^WARNING: \.env: env file/m);
    assert.deepEqual(snapshot(host), before);
    assert.equal(existsSync(marker), false, "no diff driver ran");
  });

  it("prints the listing from the command line, read-only", () => {
    const { host, marker } = populated();
    const before = snapshot(host);
    const result = spawnSync(
      process.execPath,
      [join(host, "scripts", "ralph-quarantine.mjs"), "list"],
      {
        cwd: host,
        encoding: "utf8",
        env: { ...process.env, RALPH_BASE_BRANCH: "main" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`quarantine\\s+${NEW}.*replayable`));
    assert.match(result.stdout, /incoming\s+refs\/ralph\/incoming\/.*not replayable/);
    assert.match(result.stdout, /published-copy\s+refs\/remotes\/origin\/.*not replayable/);
    assert.deepEqual(snapshot(host), before);
    assert.equal(existsSync(marker), false);
  });
});

describe("ralph-quarantine: the recovery hold (D2)", () => {
  it("is create-only, durable and lists what it preserves", () => {
    const { host, tip } = repo();
    const first = placeRecoveryHold(host, {
      slug: "01-demo",
      commit: tip,
      preserved: [NEW],
      reason: "commit failed",
    });
    assert.equal(first.ref, "refs/ralph/recovery/01-demo");
    const again = placeRecoveryHold(host, {
      slug: "01-demo",
      commit: tip,
      preserved: ["refs/ralph/incoming/x/main"],
      reason: "second",
    });
    assert.equal(again.object, first.object, "the first hold's record is kept");
    const [hold] = recoveryHolds(host);
    assert.equal(hold.slug, "01-demo");
    assert.deepEqual(hold.details.preserved, [NEW]);
    assert.equal(hold.details.commit, tip);
  });

  it("is released only with its exact identity and once the ticket is no longer ready", () => {
    const { host, tip } = repo();
    git(host, "update-ref", NEW, tip);
    const { object } = placeRecoveryHold(host, {
      slug: "01-demo",
      commit: tip,
      preserved: [NEW],
      reason: "commit failed",
    });
    refuses(
      () => releaseRecoveryHold(host, { slug: "01-demo", expect: "0".repeat(40), base: "main" }),
      /not the hold you named/,
    );
    refuses(
      () => releaseRecoveryHold(host, { slug: "01-demo", expect: object, base: "main" }),
      /still ready-for-agent/,
    );
    write(host, "issues/01-demo.md", TICKET.replace("ready-for-agent", "blocked"));
    git(host, "commit", "--quiet", "-am", "chore(issues): block by hand");
    releaseRecoveryHold(host, { slug: "01-demo", expect: object, base: "main" });
    assert.deepEqual(recoveryHolds(host), []);
    assert.equal(git(host, "rev-parse", NEW), tip, "the quarantine ref is untouched");
  });

  it("can be released for a rerun only when the human says so explicitly", () => {
    const { host, tip } = repo();
    const { object } = placeRecoveryHold(host, {
      slug: "01-demo",
      commit: tip,
      preserved: [],
      reason: "x",
    });
    releaseRecoveryHold(host, { slug: "01-demo", expect: object, base: "main", rerun: true });
    assert.deepEqual(recoveryHolds(host), []);
  });

  it("makes `holds --check` fail while any hold exists", () => {
    const { host, tip } = repo();
    const check = () =>
      spawnSync(
        process.execPath,
        [join(host, "scripts", "ralph-quarantine.mjs"), "holds", "--check"],
        { cwd: host, encoding: "utf8" },
      );
    assert.equal(check().status, 0);
    placeRecoveryHold(host, { slug: "01-demo", commit: tip, preserved: [NEW], reason: "x" });
    const held = check();
    assert.equal(held.status, 1);
    assert.match(held.stderr, /recovery hold .*01-demo.*refs\/ralph\/rejected\/01-demo/);
  });

  it("counts a hold it cannot read as a hold", () => {
    const { host, tip } = repo();
    // A hold whose record is not the module's JSON (hand-made, or damaged) still holds.
    git(host, "update-ref", "refs/ralph/recovery/01-demo", tip);
    const [hold] = recoveryHolds(host);
    assert.equal(hold.slug, "01-demo");
    assert.equal(hold.details, null);
  });

  it("counts a hold whose object is missing as held, everywhere it is read", () => {
    const { host } = repo();
    // A loose ref naming an object the repository does not have: Git cannot list it.
    write(host, ".git/refs/ralph/recovery/01-demo", `${"1".repeat(40)}\n`);
    assert.throws(() => recoveryHolds(host));
    assert.match(recoveryHoldState(host).problem ?? "", /cannot be read, so they count as held/);
    const check = spawnSync(
      process.execPath,
      [join(host, "scripts", "ralph-quarantine.mjs"), "holds", "--check"],
      { cwd: host, encoding: "utf8" },
    );
    assert.equal(check.status, 1, "an unreadable hold fails the check");
  });

  it("refuses a release it cannot check unless the human asks for a rerun", () => {
    const { host, tip } = repo();
    const { object } = placeRecoveryHold(host, {
      slug: "01-demo",
      commit: tip,
      preserved: [],
      reason: "x",
    });
    refuses(
      () => releaseRecoveryHold(host, { slug: "01-demo", expect: object, base: "no-such-base" }),
      /does not resolve to a commit/,
    );
    git(host, "rm", "--quiet", "issues/01-demo.md");
    git(host, "commit", "--quiet", "-m", "chore: move the ticket away");
    refuses(
      () => releaseRecoveryHold(host, { slug: "01-demo", expect: object, base: "main" }),
      /is not on main, so its status cannot be checked/,
    );
    assert.equal(recoveryHolds(host).length, 1, "a refused release leaves the hold");
    releaseRecoveryHold(host, { slug: "01-demo", expect: object, base: "main", rerun: true });
    assert.deepEqual(recoveryHolds(host), []);
  });
});

describe("ralph-quarantine: replay scratch refs", () => {
  it("deletes only its own namespace, and only at the commit it made", () => {
    const { host, tip } = repo();
    const main = git(host, "rev-parse", "main");
    refuses(() => removeReplayRef(host, NEW, tip), /outside refs\/ralph\/replay/);
    refuses(() => removeReplayRef(host, "refs/ralph/replay/../rejected/x", tip), /outside/);
    git(host, "update-ref", NEW, tip);
    const scratch = "refs/ralph/replay/replay-20261108102624-1/main";
    git(host, "update-ref", scratch, main);
    assert.equal(removeReplayRef(host, scratch, tip), false, "moved since: left alone");
    assert.equal(git(host, "rev-parse", scratch), main);
    assert.equal(removeReplayRef(host, scratch, main), true);
    assert.equal(git(host, "for-each-ref", "refs/ralph/replay/"), "");
    assert.equal(git(host, "rev-parse", NEW), tip);
  });
});
