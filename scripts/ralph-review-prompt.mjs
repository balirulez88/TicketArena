#!/usr/bin/env node
//
// The prompt of a Standards or Spec reviewer (skills/code-review, non-interactive mode). One
// source for both places reviews run: ralph-loop.sh's rounds inside the agent's sandbox, and the
// host's own final review of the candidate in isolated containers (scripts/ralph-host-review.mjs,
// ADR 0015). The two must ask exactly the same question, or the host would judge a different
// review than the one the loop's fix rounds converged on.
//
//   node scripts/ralph-review-prompt.mjs --axis standards|spec --ticket <file> --changeset <path>
//     --base <sha> --head <sha> --from <base branch> --register <file> [--rejected <file>]
//
// The CLI reads the changed files and commits from the repository in the working directory
// (`<from>...HEAD`), as the loop sees them.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const AXIS_BRIEF = {
  standards: `- Standards brief: judge architecture (ADRs, module boundaries, dependency direction),
  correctness (concurrency, transactions, idempotency), security (validation, authz, secrets),
  error handling, maintainability and test quality, and name integration problems with the
  existing code. \`criteria\` stays empty.`,
  spec: `- Spec brief: give every acceptance criterion above exactly one outcome in \`criteria\`, with the
  implementation evidence and the tests that verify it. A criterion with no test proving it is
  \`unverifiable\`, not \`met\`. Report missing or insufficient coverage and scope creep as findings.`,
};

/** The acceptance criteria as the review gate numbers them (scripts/ralph-review.mjs). */
export function numberedCriteria(ticketText) {
  return ticketText
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => /^- \[[ xX]\] /.test(line))
    .map((line, index) => `  AC${index + 1}: ${line.slice(6)}`);
}

/**
 * @param {object} input
 * @param {"standards" | "spec"} input.axis
 * @param {string} input.ticket       the ticket's path, as the reviewer can open it
 * @param {string} input.ticketText
 * @param {string} input.changeset    the changeset file's path inside the reviewer's workspace
 * @param {string} input.base         merge base (sha)
 * @param {string} input.head         candidate (sha)
 * @param {string} input.range        how the changeset was made, e.g. `main...HEAD`
 * @param {string[]} input.changedFiles
 * @param {string[]} input.commits    one-line commit summaries
 * @param {string} input.register     the debt register's path
 * @param {string} [input.rejected]   the gate's reasons for rejecting this reviewer's last report
 */
export function reviewPrompt(input) {
  const Axis = input.axis[0].toUpperCase() + input.axis.slice(1);
  const lines = [
    `You are the ${Axis} sub-agent of the two-axis code review in skills/code-review/SKILL.md, in`,
    `its non-interactive mode, reviewing ticket ${input.ticket}. Read that skill file first and follow the`,
    `brief for the ${Axis} axis. You run in a fresh context, independent of the other axis.`,
    "",
    `- Commit range: base ${input.base}, head ${input.head} (copy both into \`changeset\`). The complete`,
    `  candidate changeset, \`git diff ${input.range}\` annotated with source line numbers,`,
    "  is saved in full in the changeset file below. Read all of it, then whatever surrounding code",
    "  you need.",
    `- Changeset file: ${input.changeset}`,
    "  Its last line is `review-token: <value>`; put that value in `changeset.token`. If you",
    "  cannot open the file, review nothing else: say so in the summary and leave the token empty.",
    "- Changed files (account for every one in `files`):",
    ...input.changedFiles.map((file) => `  ${file}`),
    "- Every finding names one of those files and a line inside one of its hunks (0: whole file).",
    "  Each hunk line of the changeset is prefixed with its OLD and NEW source line numbers: cite",
    "  those (NEW for added or unchanged lines), never a line's position within the changeset file.",
    `- Commits: ${input.commits.map((commit) => `${commit};`).join("")}`,
    `- Spec: the ticket ${input.ticket} and the spec and ADRs it references. Acceptance criteria:`,
    ...numberedCriteria(input.ticketText),
    AXIS_BRIEF[input.axis],
    "- Standards: discover the sources as the skill describes, starting from CLAUDE.md.",
    `- Technical debt: ${input.register} is the register of findings deferred by earlier reviews.`,
    "  Read the entries whose Components overlap the changed files. If a finding of yours is the same",
    '  problem as an entry, set `debt` to its id (else ""); do not lower its severity because it',
    "  is known. If this change makes a deferred problem worse or newly reachable, rate it by its real",
    "  impact now, which may be HIGH or CRITICAL. If the changeset marks an entry RESOLVED, check the",
    "  fix and its test: a resolution its Verification test does not prove is a HIGH finding.",
    "  Cite a RESOLVED entry with an Escalation only at a blocking severity (its problem is back or",
    '  unproven); a different, remaining concern about its fix is a new finding with `debt` "".',
    "- You are read-only: do not modify any file. Return only the report matching the JSON schema.",
  ];
  if (input.rejected !== undefined) {
    lines.push(
      "- Your previous report on this exact changeset was rejected by the review gate as invalid, for",
      "  these reasons. Review again from scratch and return a report that follows the schema and the",
      "  rules above; the gate's rules have not changed.",
      ...input.rejected
        .replace(/\r/g, "")
        .replace(/\n+$/, "")
        .split("\n")
        .map((line) => `  ${line}`),
    );
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function gitLines(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function main() {
  const { values } = parseArgs({
    options: {
      axis: { type: "string" },
      ticket: { type: "string" },
      changeset: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      from: { type: "string" },
      register: { type: "string" },
      rejected: { type: "string" },
    },
  });
  for (const name of ["axis", "ticket", "changeset", "base", "head", "from", "register"]) {
    if (!values[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  if (!(values.axis in AXIS_BRIEF)) {
    throw new Error("--axis must be standards or spec");
  }
  process.stdout.write(
    reviewPrompt({
      axis: values.axis,
      ticket: values.ticket,
      ticketText: readFileSync(values.ticket, "utf8"),
      changeset: values.changeset,
      base: values.base,
      head: values.head,
      range: `${values.from}...HEAD`,
      changedFiles: gitLines("diff", "--name-only", `${values.from}...HEAD`),
      commits: gitLines("log", "--oneline", `${values.from}..HEAD`),
      register: values.register,
      rejected: values.rejected === undefined ? undefined : readFileSync(values.rejected, "utf8"),
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`review prompt: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
