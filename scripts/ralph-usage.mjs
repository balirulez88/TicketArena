#!/usr/bin/env node
//
// What a run spent, as the Claude CLI reports it. `claude -p --output-format=json` ends every
// session with one result object carrying `usage` (tokens) and `total_cost_usd`. `usage` counts
// only the session's own turns; `modelUsage` (per model) and `total_cost_usd` include the
// subagents' turns (measured: a Lead that called one subagent reported more output tokens in
// `modelUsage` than in `usage`, and a total cost equal to the `modelUsage` sum), so tokens are
// summed from `modelUsage` when it has them. The lead driver
// keeps the Lead's as <slug>.lead.json and the reviewers keep theirs next to the review reports,
// so this script only reads files; it never runs or trusts anything.
//
//   node scripts/ralph-usage.mjs <file or directory>...
//
// Directories are searched recursively for *.json files that hold a result object. Prints a
// Markdown table (one row per session file, then the total).
//
// The dollar figure is the CLI's arithmetic at API list prices. It is NOT subscription usage: a
// plan meters differently and the two cannot be converted into each other. Compare tokens, and
// read the plan's own usage meter before and after a run for anything about the plan.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
  ["cacheWrite", "cache_creation_input_tokens"],
];

const MODEL_FIELDS = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["cacheRead", "cacheReadInputTokens"],
  ["cacheWrite", "cacheCreationInputTokens"],
];

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// Tokens over every model the session used, subagents included; null if modelUsage has none.
function modelTokens(modelUsage) {
  const models = Object.values(modelUsage ?? {}).filter(
    (model) => model !== null && typeof model === "object",
  );
  if (!models.some((model) => MODEL_FIELDS.some(([, field]) => typeof model[field] === "number"))) {
    return null;
  }
  return Object.fromEntries(
    MODEL_FIELDS.map(([name, field]) => [
      name,
      models.reduce((total, model) => total + count(model[field]), 0),
    ]),
  );
}

/** The usage a CLI result object reports, or null if the text is not one. */
export function usageOf(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return null;
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const hasCost = typeof result.total_cost_usd === "number";
  if (!(hasCost || (result.usage && typeof result.usage === "object"))) {
    return null;
  }
  const tokens =
    modelTokens(result.modelUsage) ??
    Object.fromEntries(TOKEN_FIELDS.map(([name, field]) => [name, count(result.usage?.[field])]));
  return {
    ...tokens,
    costUsd: hasCost ? result.total_cost_usd : null,
    models: Object.keys(result.modelUsage ?? {}).sort(),
    subagents: count(result.subagent_stats?.spawned),
    error: result.is_error === true,
  };
}

function* jsonFiles(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      yield* jsonFiles(join(path, name));
    }
  } else if (path.endsWith(".json")) {
    yield path;
  }
}

/** One entry per result file under `paths`; files that are not CLI results are skipped. */
export function collect(paths) {
  const rows = [];
  for (const path of paths) {
    for (const file of jsonFiles(path)) {
      const usage = usageOf(readFileSync(file, "utf8"));
      if (usage) {
        rows.push({ file: basename(file), ...usage });
      }
    }
  }
  return rows;
}

const n = (value) => value.toLocaleString("en-US");

export function render(rows) {
  const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
  const costs = rows.map((row) => row.costUsd);
  const costKnown = costs.every((cost) => cost !== null);
  const cost = (value) => (value === null ? "n/a" : `$${value.toFixed(4)}`);
  const total = costKnown
    ? cost(costs.reduce((a, b) => a + b, 0))
    : "n/a (a session reported no cost)";
  const lines = [
    "| session file | reported cost | input | output | cache read | cache write | subagents | models |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      (row) =>
        `| ${row.file}${row.error ? " (error)" : ""} | ${cost(row.costUsd)} | ${n(row.input)} | ${n(row.output)} | ${n(row.cacheRead)} | ${n(row.cacheWrite)} | ${row.subagents} | ${row.models.join(", ") || "n/a"} |`,
    ),
    `| **total (${rows.length})** | ${total} | ${n(sum("input"))} | ${n(sum("output"))} | ${n(sum("cacheRead"))} | ${n(sum("cacheWrite"))} | ${sum("subagents")} | |`,
    "",
    "Reported cost is the CLI's API-price arithmetic, not subscription usage; compare tokens and",
    "read the plan's own usage meter. Sessions that produced no result (killed) are not counted.",
  ];
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: ralph-usage.mjs <file or directory>...");
    process.exitCode = 2;
  } else {
    try {
      const rows = collect(paths);
      const text = rows.length === 0 ? "No session result files found." : render(rows);
      process.stdout.write(`${text}
`);
    } catch (error) {
      console.error(`ralph-usage: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
