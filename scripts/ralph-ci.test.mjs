// scripts/ralph-ci.sh against a stub `gh` that answers `gh run list` with STUB_GH's lines, one
// per call (the last one repeats). Only a completed, successful run may count as a pass.

import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ralph-ci.sh", import.meta.url));

function ci(answers, { fail = false, appear = "1" } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "ralph-ci-"));
  const calls = join(bin, "calls");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      `echo "$*" >>"${calls.replaceAll("\\", "/")}"`,
      fail ? "echo 'HTTP 502' >&2; exit 1" : "",
      `n=$(wc -l <"${calls.replaceAll("\\", "/")}")`,
      // Answer number n, or the last one once they run out.
      `awk -v n="$n" 'NR <= n { answer = $0 } END { print answer }' <<<"$STUB_GH"`,
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", [script, "abc123"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      STUB_GH: answers.join("\n"),
      RALPH_CI_POLL: "0",
      RALPH_CI_APPEAR_TIMEOUT: appear,
      RALPH_CI_TIMEOUT: appear === "1" ? "2" : appear,
    },
  });
  return { code: result.status, err: result.stderr };
}

describe("ralph-ci.sh", () => {
  it("passes only a completed, successful run, waiting for it to finish", () => {
    const { code, err } = ci(
      ["null null null", "in_progress  https://x/1", "completed success https://x/1"],
      { appear: "60" },
    );
    assert.equal(code, 0, err);
    assert.match(err, /CI passed: https:\/\/x\/1/);
  });

  it("a failed run is a definite failure", () => {
    assert.equal(ci(["completed failure https://x/1"], { appear: "60" }).code, 1);
    assert.equal(ci(["completed timed_out https://x/1"], { appear: "60" }).code, 1);
  });

  it("a cancelled or skipped run is unknown, never a pass", () => {
    assert.equal(ci(["completed cancelled https://x/1"]).code, 2);
    assert.equal(ci(["completed skipped https://x/1"]).code, 2);
  });

  it("no run in time, a run that never finishes, or gh failing is unknown", () => {
    assert.equal(ci(["null null null"]).code, 2);
    assert.equal(ci(["in_progress  https://x/1"]).code, 2);
    assert.equal(ci([], { fail: true }).code, 2);
  });
});
