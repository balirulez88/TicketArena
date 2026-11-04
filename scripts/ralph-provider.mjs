#!/usr/bin/env node
//
// Provider-failure classification for ralph-loop.sh. A Claude session can fail because the
// provider refused or dropped it (usage limit, rate limit, overload, outage, bad credentials)
// rather than because the agent's work is wrong. Charging such a failure to the ticket (an
// implementation attempt, a review round, a rejection) punishes the code for the weather, so the
// harness retries or pauses instead. The reverse mistake is worse: a genuine failure classified
// as the provider's would get free retries and dodge the attempt limit. So this module only
// recognises the provider's own error formats, only in a session that actually failed, and
// answers `none` (a genuine failure, judged as before) whenever it is not sure.
//
//   node scripts/ralph-provider.mjs classify --exit <code> <output file>...
//
// Prints one class:
//   usage-limit  the account's usage or credit is exhausted; retrying soon cannot help: pause
//   auth         the credentials were refused; a human must fix them: pause
//   transient    rate limit (429), overload (529), server error (5xx), network: retry, bounded
//   none         no confident provider signal: a genuine failure

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Only the end of the output is the CLI's own verdict; earlier lines can be anything the agent
// printed or quoted, including these very phrases.
const TAIL_LINES = 30;
// The timeout(1) exit code: a session the harness cut off is not known to be the provider's fault.
const TIMED_OUT = 124;

// Claude Code's own messages, newest wording first. Each is anchored on phrasing the model has no
// reason to produce as its final answer in a failed session.
const USAGE_LIMIT = [
  /Claude AI usage limit reached/i,
  /\byou(?:'ve| have) (?:hit|reached) your (?:usage )?limit\b/i,
  /\b(?:5-hour|five-hour|session|daily|weekly|monthly|opus|sonnet) (?:usage )?limit reached\b/i,
  /\busage limit\b[^\n]*\bresets?\b/i,
  /\bout of extra usage\b/i,
  /\bcredit balance is too low\b/i,
];
const AUTH = [
  /\bAPI Error: (?:401|403)\b/,
  /\bauthentication_error\b/,
  /\bpermission_error\b/,
  /\binvalid (?:x-)?api[ -]key\b/i,
  /\bOAuth token (?:has )?expired\b/i,
  /\bplease run \/login\b/i,
];
const TRANSIENT = [
  /\bAPI Error: (?:429|5\d\d)\b/,
  /\b(?:rate_limit_error|overloaded_error)\b/,
  /\bAPI Error:? \(?(?:Connection error|Request timed out|fetch failed)/i,
  /\bAPI Error\b[^\n]*\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up)\b/,
];

const matches = (patterns, text) => patterns.some((pattern) => pattern.test(text));

// The error result a line holds, or null: `claude -p --output-format=json` reports a failed
// session as `{"type":"result","is_error":true,...}`.
function errorResult(line) {
  try {
    const value = JSON.parse(line);
    return value?.type === "result" && value.is_error === true ? value : null;
  } catch {
    return null;
  }
}

// Error results are the most reliable signal there is. Returns whether one was reported, the
// error text it carries and its HTTP status, if any.
function resultErrors(lines) {
  const found = { failed: false, text: [], status: null };
  for (const value of lines.map(errorResult).filter(Boolean)) {
    found.failed = true;
    found.text.push(
      ...[value.result, value.error, value.subtype].filter((f) => typeof f === "string"),
    );
    if (Number.isInteger(value.api_error_status)) {
      found.status = value.api_error_status;
    }
  }
  return found;
}

/**
 * @param {{ exitCode: number, output: string }} session
 * @returns {"usage-limit" | "auth" | "transient" | "none"}
 */
export function classify({ exitCode, output }) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-TAIL_LINES);
  const result = resultErrors(lines);
  // A session that succeeded is never a provider failure, whatever its text says.
  if ((exitCode === 0 && !result.failed) || exitCode === TIMED_OUT) {
    return "none";
  }
  const text = [...lines, ...result.text].join("\n");
  if (matches(USAGE_LIMIT, text)) {
    return "usage-limit";
  }
  if (matches(AUTH, text) || result.status === 401 || result.status === 403) {
    return "auth";
  }
  if (
    matches(TRANSIENT, text) ||
    result.status === 429 ||
    (result.status !== null && result.status >= 500)
  ) {
    return "transient";
  }
  return "none";
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { exit: { type: "string" } },
  });
  const [command, ...files] = positionals;
  const exitCode = Number(values.exit);
  if (command !== "classify" || !Number.isInteger(exitCode) || files.length === 0) {
    throw new Error("usage: ralph-provider.mjs classify --exit <code> <output file>...");
  }
  const output = files
    .map((file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  process.stdout.write(`${classify({ exitCode, output })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    // The harness reads anything but a class as `none`: an unclassifiable failure is genuine.
    console.error(`ralph-provider: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
