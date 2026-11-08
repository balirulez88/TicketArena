#!/usr/bin/env node
//
// Stand-in for `vitest run --reporter=json --outputFile=<file> <test files>` in the harness tests
// (scripts/ralph-loop.test.sh, scripts/sandbox.test.sh), passed as RALPH_TEST_RUNNER. It reports
// every test file it is given as one test failing on an assertion, as a genuine RED would, or as
// failing to load with STUB_VITEST_LOAD_ERROR set. STUB_VITEST_LOG, if set, logs each call.

import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Configured like any test double, by the caller's environment.
const { STUB_VITEST_LOG: log, STUB_VITEST_LOAD_ERROR: loadError } = process.env;
const args = process.argv.slice(2);
if (log) {
  appendFileSync(log, `vitest ${args.join(" ")}\n`);
}
const out = args.find((arg) => arg.startsWith("--outputFile="))?.slice("--outputFile=".length);
const files = args.filter((arg) => !arg.startsWith("--") && arg !== "run");
// Flags (a runner string can carry them where the environment cannot reach): --pass reports every
// test as passing; --load-error is STUB_VITEST_LOAD_ERROR.
const passing = args.includes("--pass");
const failToLoad = loadError || args.includes("--load-error");
const failing = [{ status: "failed", fullName: "the missing behaviour" }];
const testResults = files.map((file) =>
  failToLoad
    ? { name: resolve(file), status: "failed", message: "Cannot find module", assertionResults: [] }
    : {
        name: resolve(file),
        status: passing ? "passed" : "failed",
        message: "",
        assertionResults: passing ? [{ status: "passed", fullName: "ok" }] : failing,
      },
);
if (out) {
  writeFileSync(out, JSON.stringify({ testResults }));
}
process.exit(1);
