import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  cleanup,
  initRoot,
  markRun,
  redactRun,
  redactText,
  removeRun,
  secretValues,
} from "./ralph-artifacts.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * DAY_MS);

let base;
let reviewRoot;
let logRoot;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ralph-artifacts-"));
  reviewRoot = join(base, "review");
  logRoot = join(base, "logs");
  initRoot(reviewRoot);
  initRoot(logRoot);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A run as ralph-loop.sh leaves it: a log dir with run.json and, optionally, a review dir. */
function makeRun(id, { status, finishedDaysAgo = 0, review = true }) {
  const logDir = join(logRoot, id);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "02-ticket.review-1.diff"), "diff\n");
  markRun(logDir, "active", daysAgo(finishedDaysAgo + 1));
  if (status !== "active") {
    markRun(logDir, status, daysAgo(finishedDaysAgo));
  }
  if (review) {
    mkdirSync(join(reviewRoot, id), { recursive: true });
    writeFileSync(join(reviewRoot, id, "02-ticket.review-1.diff"), "diff\n");
  }
}

const sweep = (keep) => cleanup({ reviewRoot, logRoot, keep, now: NOW });

describe("review artifact retention", () => {
  it("deletes the temporary review files of a succeeded run, keeping its logs", () => {
    makeRun("20261030-110000", { status: "succeeded" });
    sweep();
    assert.equal(existsSync(join(reviewRoot, "20261030-110000")), false);
    assert.equal(existsSync(join(logRoot, "20261030-110000", "02-ticket.review-1.diff")), true);
  });

  it("keeps a failed run's review files for 7 days, then deletes them", () => {
    makeRun("20261024-120000", { status: "failed", finishedDaysAgo: 6 });
    makeRun("20261022-120000", { status: "failed", finishedDaysAgo: 8 });
    sweep();
    assert.equal(existsSync(join(reviewRoot, "20261024-120000")), true);
    assert.equal(existsSync(join(reviewRoot, "20261022-120000")), false);
    assert.equal(existsSync(join(logRoot, "20261022-120000")), true);
  });

  it("never touches an active run, however old", () => {
    makeRun("20260101-000000", { status: "active", finishedDaysAgo: 300 });
    sweep();
    assert.equal(existsSync(join(reviewRoot, "20260101-000000")), true);
    assert.equal(existsSync(join(logRoot, "20260101-000000")), true);
  });

  it("never touches the run that is starting", () => {
    makeRun("20261030-115959", { status: "failed", finishedDaysAgo: 60 });
    sweep("20261030-115959");
    assert.equal(existsSync(join(reviewRoot, "20261030-115959")), true);
    assert.equal(existsSync(join(logRoot, "20261030-115959")), true);
  });

  it("ages a review dir without run metadata by its modification time", () => {
    const old = join(reviewRoot, "20260901-000000");
    mkdirSync(old);
    utimesSync(old, daysAgo(10), daysAgo(10));
    mkdirSync(join(reviewRoot, "20261029-000000"));
    sweep();
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(join(reviewRoot, "20261029-000000")), true);
  });
});

describe("log retention", () => {
  it("deletes logs 30 days after the run finished and keeps younger ones", () => {
    makeRun("20260925-120000", { status: "succeeded", finishedDaysAgo: 31, review: false });
    makeRun("20261005-120000", { status: "failed", finishedDaysAgo: 25, review: false });
    const removed = sweep();
    assert.deepEqual(removed, [join(logRoot, "20260925-120000")]);
    assert.equal(existsSync(join(logRoot, "20261005-120000")), true);
  });

  it("is idempotent", () => {
    makeRun("20260925-120000", { status: "failed", finishedDaysAgo: 31 });
    assert.equal(sweep().length, 2);
    assert.deepEqual(sweep(), []);
  });
});

describe("cleanup stays inside the Ralph-managed directories", () => {
  it("refuses a root without the managed marker", () => {
    const foreign = join(base, "foreign");
    mkdirSync(join(foreign, "20200101-000000"), { recursive: true });
    assert.throws(
      () => cleanup({ reviewRoot: foreign, logRoot, now: NOW }),
      /not a Ralph-managed directory/,
    );
    assert.equal(existsSync(join(foreign, "20200101-000000")), true);
  });

  it("ignores entries that are not run directories", () => {
    for (const name of ["src", "notes-20200101-000000", "20200101-000000.txt"]) {
      const path = join(logRoot, name);
      if (name.endsWith(".txt")) {
        writeFileSync(path, "x");
      } else {
        mkdirSync(path);
      }
      utimesSync(path, daysAgo(400), daysAgo(400));
    }
    sweep();
    assert.equal(existsSync(join(logRoot, "src")), true);
    assert.equal(existsSync(join(logRoot, "notes-20200101-000000")), true);
    assert.equal(existsSync(join(logRoot, "20200101-000000.txt")), true);
    assert.equal(existsSync(join(logRoot, ".ralph-managed")), true);
  });

  it("never follows a link named like a run out of the root", () => {
    const outside = join(base, "precious");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "source");
    utimesSync(outside, daysAgo(400), daysAgo(400));
    // A junction needs no privileges on Windows; elsewhere the type is ignored.
    symlinkSync(outside, join(logRoot, "20200101-000000"), "junction");
    sweep();
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "source");
  });

  it("removes a finished run's review dir only by a well-formed run id", () => {
    makeRun("20261030-110000", { status: "succeeded" });
    assert.throws(() => removeRun(reviewRoot, "../logs"), /--run-id must look like/);
    assert.throws(() => removeRun(reviewRoot, ""), /--run-id must look like/);
    assert.equal(removeRun(reviewRoot, "20261030-110000"), true);
    assert.equal(removeRun(reviewRoot, "20261030-110000"), false);
    assert.equal(existsSync(join(logRoot, "20261030-110000")), true);
  });
});

describe("secret redaction", () => {
  it("collects long values of secret-named variables only", () => {
    const secrets = secretValues({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-value-123456",
      DATABASE_PASSWORD: "short",
      PATH: "/usr/bin:/bin:/usr/local/bin",
    });
    assert.deepEqual(secrets, ["oauth-value-123456"]);
  });

  it("scrubs secret values and Anthropic keys from every file of a run", () => {
    const logDir = join(logRoot, "20261030-110000");
    mkdirSync(join(logDir, "nested"), { recursive: true });
    writeFileSync(join(logDir, "agent.log"), "token oauth-value-123456 used\n");
    writeFileSync(join(logDir, "nested", "env.log"), "key sk-ant-api03-abcdefghijkl\n");
    writeFileSync(join(logDir, "clean.log"), "nothing here\n");
    const redacted = redactRun(logDir, ["oauth-value-123456"]);
    assert.equal(redacted.length, 2);
    assert.equal(readFileSync(join(logDir, "agent.log"), "utf8"), "token [REDACTED] used\n");
    assert.equal(readFileSync(join(logDir, "nested", "env.log"), "utf8"), "key [REDACTED]\n");
    assert.equal(redactText("plain", []), "plain");
  });
});
