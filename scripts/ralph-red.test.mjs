import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluate, owningPackage, planRun, workspaceGlobs } from "./ralph-red.mjs";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "ralph-red-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const pkg = (dir, scripts) => {
    mkdirSync(join(root, dir, "src"), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, scripts }));
  };
  pkg("packages/messaging", { test: "vitest run" });
  pkg("packages/notest", {});
  mkdirSync(join(root, "packages/scaffoldless/src"), { recursive: true });
  return root;
}

const deps = (root) => ({ root, exists: existsSync, readText: (p) => readFileSync(p, "utf8") });

const result = (root, file, assertionResults, extra = {}) => ({
  name: join(root, file).split("\\").join("/"),
  status: assertionResults.some((a) => a.status === "failed") ? "failed" : "passed",
  message: "",
  assertionResults,
  ...extra,
});
const failing = { status: "failed", fullName: "relay polls every 250 ms" };
const passing = { status: "passed", fullName: "already true" };
const skipped = { status: "skipped", fullName: "later" };

describe("test discovery", () => {
  it("reads the workspace globs", () => {
    assert.deepEqual(workspaceGlobs('packages:\n  - "apps/*"\n  - packages/*\nallowBuilds:\n'), [
      "apps/*",
      "packages/*",
    ]);
  });

  it("finds the package that owns a test file", () => {
    const root = workspace();
    assert.equal(
      owningPackage("packages/messaging/src/relay.test.ts", deps(root)),
      "packages/messaging",
    );
    assert.equal(owningPackage("packages/scaffoldless/src/relay.test.ts", deps(root)), null);
  });

  it("rejects a test in a package that does not exist yet or has no test script", () => {
    const root = workspace();
    const { groups, errors } = planRun(
      [
        "packages/messaging/src/relay.test.ts",
        "packages/scaffoldless/src/relay.test.ts",
        "packages/notest/src/a.test.ts",
      ],
      deps(root),
    );
    assert.deepEqual(
      [...groups],
      [["packages/messaging", ["packages/messaging/src/relay.test.ts"]]],
    );
    assert.match(errors[0] ?? "", /scaffoldless.*not inside a workspace package/);
    assert.match(errors[1] ?? "", /notest, which has no "test" script/);
  });
});

describe("RED evidence", () => {
  const root = workspace();
  const file = "packages/messaging/src/relay.test.ts";
  const other = "packages/messaging/src/bus.test.ts";

  it("accepts a new test that ran and failed on an assertion", () => {
    const verdict = evaluate([file], [{ testResults: [result(root, file, [failing, passing])] }], {
      root,
    });
    assert.deepEqual(verdict, {
      ok: true,
      errors: [],
      failed: [`${file} > relay polls every 250 ms`],
    });
  });

  it("rejects a run that wrote no report: zero tests executed", () => {
    const verdict = evaluate([file], [null], { root });
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join(), /was not executed/);
  });

  it("rejects a test file the runner did not match, even when another one fails", () => {
    const verdict = evaluate([file, other], [{ testResults: [result(root, file, [failing])] }], {
      root,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join(), /bus\.test\.ts was not executed/);
  });

  it("rejects a test file that fails to load: its failure proves no behaviour", () => {
    const broken = result(root, file, [], {
      status: "failed",
      message: "Cannot find module './relay.js'\n    at stack",
    });
    const verdict = evaluate([file], [{ testResults: [broken] }], { root });
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join(), /failed to load.*Cannot find module '\.\/relay\.js'$/);
  });

  it("rejects a file whose tests are all skipped", () => {
    const verdict = evaluate([file], [{ testResults: [result(root, file, [skipped])] }], { root });
    assert.match(verdict.errors.join(), /executed no test/);
  });

  it("rejects new tests that all pass", () => {
    const verdict = evaluate([file], [{ testResults: [result(root, file, [passing])] }], { root });
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join(), /every new test ran and passed/);
  });
});

describe("the command", () => {
  const script = join(import.meta.dirname, "ralph-red.mjs");

  it("never reuses an earlier attempt's report as evidence", () => {
    const root = workspace();
    const file = "packages/messaging/src/relay.test.ts";
    writeFileSync(join(root, file), "");
    const out = join(root, "red.vitest");
    mkdirSync(out);
    // A report from an earlier attempt that did prove RED; this attempt's runner writes none.
    writeFileSync(
      join(out, "red-0.json"),
      JSON.stringify({ testResults: [result(root, file, [failing])] }),
    );
    const run = spawnSync(
      process.execPath,
      [script, "--root", root, "--runner", "node -e 0", "--out", out, file],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1);
    assert.match(run.stdout, /relay\.test\.ts was not executed/);
    assert.ok(existsSync(join(out, "red-0.log")));
  });
});
