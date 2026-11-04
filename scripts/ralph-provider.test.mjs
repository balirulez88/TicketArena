import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classify } from "./ralph-provider.mjs";

const failed = (output) => classify({ exitCode: 1, output });
const jsonResult = (fields) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: true, ...fields });

describe("provider failures are recognised from the CLI's own messages", () => {
  it("usage limits, old and new wording", () => {
    for (const output of [
      "Claude AI usage limit reached|1762300800",
      "You've hit your limit · resets 3pm (Europe/Budapest)",
      "5-hour limit reached ∙ resets 1am",
      "Weekly limit reached ∙ resets Nov 7, 9am",
      "Opus limit reached ∙ resets 11pm",
      "Credit balance is too low",
    ]) {
      assert.equal(failed(output), "usage-limit", output);
    }
  });

  it("refused credentials", () => {
    for (const output of [
      "Invalid API key · Please run /login",
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ]) {
      assert.equal(failed(output), "auth", output);
    }
  });

  it("rate limits, overload, server errors and network failures", () => {
    for (const output of [
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      "API Error: Connection error.",
      "API Error: Request timed out.",
      "API Error: read ECONNRESET",
    ]) {
      assert.equal(failed(output), "transient", output);
    }
  });

  it("a JSON error result (reviewers) by its text or its HTTP status", () => {
    assert.equal(failed(jsonResult({ result: "Claude AI usage limit reached|1" })), "usage-limit");
    assert.equal(failed(jsonResult({ result: "", api_error_status: 529 })), "transient");
    assert.equal(failed(jsonResult({ result: "", api_error_status: 401 })), "auth");
    // `is_error` marks a failure even when the process exited 0.
    assert.equal(
      classify({ exitCode: 0, output: jsonResult({ result: "API Error: 529 overloaded_error" }) }),
      "transient",
    );
  });

  it("a usage limit wins over the transient error that reported it", () => {
    assert.equal(
      failed("API Error: 429 rate_limit_error\nClaude AI usage limit reached|1"),
      "usage-limit",
    );
  });
});

describe("anything uncertain is a genuine failure (fails closed)", () => {
  it("a session that succeeded, whatever it says", () => {
    assert.equal(
      classify({ exitCode: 0, output: "Done. Note: the API returned API Error: 529 earlier." }),
      "none",
    );
    assert.equal(classify({ exitCode: 0, output: "Claude AI usage limit reached|1" }), "none");
  });

  it("a session the harness timed out", () => {
    assert.equal(classify({ exitCode: 124, output: "API Error: 529 overloaded_error" }), "none");
  });

  it("ordinary failures and near misses", () => {
    for (const output of [
      "",
      "Error: tests failed",
      "Segmentation fault",
      // The model discussing rate limits is not the CLI reporting one.
      "I implemented the 429 handler; rate limits now return a retry hint.",
      "the usage limit of a buyer is 6 seats",
      "connect ECONNREFUSED 127.0.0.1:5432",
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
    ]) {
      assert.equal(failed(output), "none", output);
    }
  });

  it("only the end of the output counts", () => {
    const quoted = `Claude AI usage limit reached|1\n${"working...\n".repeat(40)}Error: tests failed`;
    assert.equal(failed(quoted), "none");
  });
});

describe("CLI", () => {
  const script = fileURLToPath(new URL("./ralph-provider.mjs", import.meta.url));
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("classifies the combined output files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-provider-"));
    writeFileSync(join(dir, "out.json"), "");
    writeFileSync(join(dir, "err.log"), "API Error: 529 overloaded_error\n");
    const result = run(["classify", "--exit", "1", join(dir, "out.json"), join(dir, "err.log")]);
    assert.equal(result.stdout.trim(), "transient");
  });

  it("a missing file reads as empty", () => {
    assert.equal(run(["classify", "--exit", "1", "/no/such/file"]).stdout.trim(), "none");
  });

  it("bad usage prints no class", () => {
    const result = run(["classify", "--exit", "x", "f"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  });
});
