import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, render, usageOf } from "./ralph-usage.mjs";

const SCRIPT = fileURLToPath(new URL("./ralph-usage.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ralph-usage-"));

const result = (cost, usage, extra = {}) =>
  JSON.stringify({
    type: "result",
    total_cost_usd: cost,
    usage: {
      input_tokens: usage[0],
      output_tokens: usage[1],
      cache_read_input_tokens: usage[2],
      cache_creation_input_tokens: usage[3],
    },
    ...extra,
  });

describe("session usage as the CLI reports it", () => {
  it("reads tokens, cost and models from a result object", () => {
    const usage = usageOf(result(1.5, [10, 20, 300, 40], { modelUsage: { b: {}, a: {} } }));
    assert.deepEqual(usage, {
      input: 10,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
      costUsd: 1.5,
      models: ["a", "b"],
      subagents: 0,
      error: false,
    });
  });

  it("counts subagent turns: tokens come from modelUsage, which includes them, not from usage", () => {
    // Measured shape: a session that called one subagent. `usage` has only its own turns.
    const text = result(0.0047, [4, 550, 45073, 14021], {
      modelUsage: {
        "claude-haiku-5-5": {
          inputTokens: 8,
          outputTokens: 918,
          cacheReadInputTokens: 51576,
          cacheCreationInputTokens: 21430,
          costUSD: 0.0047,
        },
      },
      subagent_stats: { spawned: 1 },
    });
    assert.deepEqual(usageOf(text), {
      input: 8,
      output: 918,
      cacheRead: 51576,
      cacheWrite: 21430,
      costUsd: 0.0047,
      models: ["claude-haiku-5-5"],
      subagents: 1,
      error: false,
    });
  });

  it("ignores text that is not a result object", () => {
    for (const text of ["", "not json", "[]", "null", '{"verdict":"blocked"}']) {
      assert.equal(usageOf(text), null, text);
    }
  });

  it("keeps a session without a cost visible instead of reading it as free", () => {
    const rows = [
      { file: "a.json", ...usageOf(result(1, [1, 1, 1, 1])) },
      { file: "b.json", ...usageOf(JSON.stringify({ usage: { output_tokens: 5 } })) },
    ];
    const table = render(rows);
    assert.match(table, /n\/a \(a session reported no cost\)/);
    assert.match(table, /\| b\.json \| n\/a \|/);
  });

  it("collects every result file under a directory", () => {
    mkdirSync(join(dir, "logs", "sub"), { recursive: true });
    writeFileSync(join(dir, "logs", "12-x.lead.json"), result(2, [1, 2, 3, 4]));
    writeFileSync(join(dir, "logs", "sub", "review.json"), result(0.5, [5, 6, 7, 8]));
    writeFileSync(join(dir, "logs", "run.json"), '{"status":"failed"}');
    writeFileSync(join(dir, "logs", "notes.txt"), result(99, [9, 9, 9, 9]));
    const rows = collect([join(dir, "logs")]);
    assert.deepEqual(
      rows.map((row) => row.file),
      ["12-x.lead.json", "review.json"],
    );
    const table = render(rows);
    assert.match(table, /\*\*total \(2\)\*\* \| \$2\.5000 \| 6 \| 8 \| 10 \| 12 \|/);
    assert.match(table, /not subscription usage/);
  });

  it("runs as a command, and refuses a missing path or no path", () => {
    const ok = spawnSync(process.execPath, [SCRIPT, join(dir, "logs")], { encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /12-x\.lead\.json/);
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    assert.equal(none.status, 2);
    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, "nothing-here")], {
      encoding: "utf8",
    });
    assert.equal(missing.status, 1);
  });
});
