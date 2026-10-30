#!/usr/bin/env node
//
// Stand-in for the `claude` binary in scripts/ralph-sessions.test.sh. It is launched by
// ralph-loop.sh's DEFAULT agent and reviewer commands, so it observes the real launch
// configuration. Every invocation appends one JSON line to FAKE_CLAUDE_LEDGER: the arguments,
// the isolation environment, whether its config dir started empty, and which tickets were
// archived when it ran. Then it leaves state behind (a memory file in its config dir, a transcript
// marker on stdout) that a leaky harness would carry into the next session.
//
// As an agent (no --json-schema) it implements the ticket: GREEN writes feature-<NN>.txt. As a
// reviewer it delegates to scripts/ralph-stub-reviewer.mjs.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const reviewer = args.includes("--json-schema");
// The launch environment under test, read once.
const {
  CLAUDE_CONFIG_DIR: configDir = "",
  FAKE_CLAUDE_LEDGER: ledger = "",
  RALPH_TICKET: agentTicket,
  RALPH_PHASE: phase,
  RALPH_SESSION_ID: envSession = null,
  DISABLE_COMPACT: disableCompact = null,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: disableAutoMemory = null,
} = process.env;
const ticket = agentTicket ?? /reviewing ticket issues\/(\d{2})-/.exec(prompt)?.[1] ?? "";
const session = args[args.indexOf("--session-id") + 1] ?? "";

const configEntries = configDir && existsSync(configDir) ? readdirSync(configDir) : null;
const doneDir = join("issues", "done");
appendFileSync(
  ledger,
  `${JSON.stringify({
    role: reviewer ? "reviewer" : "agent",
    ticket,
    phase: phase ?? "review",
    // The prompt and the schema are content, not launch configuration.
    flags: args.slice(0, -1).filter((_arg, index, all) => all[index - 1] !== "--json-schema"),
    session: args.includes("--session-id") ? session : null,
    envSession,
    configDir,
    configEmptyAtStart: configEntries !== null && configEntries.length === 0,
    disableCompact,
    disableAutoMemory,
    prompt,
    archived: existsSync(doneDir) ? readdirSync(doneDir).sort() : [],
  })}\n`,
);

// State a resumed or shared session would leak into the next one.
if (configDir) {
  mkdirSync(join(configDir, "projects"), { recursive: true });
  writeFileSync(join(configDir, "projects", "MEMORY.md"), `ticket ${ticket} was here\n`);
}

if (reviewer) {
  const stub = join(dirname(fileURLToPath(import.meta.url)), "ralph-stub-reviewer.mjs");
  const result = spawnSync(process.execPath, [stub, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (phase === "green") {
  writeFileSync(`feature-${ticket}.txt`, `ticket ${ticket}\n`);
}
process.stdout.write(`TRANSCRIPT-MARKER ticket ${ticket} session ${session}\n`);
