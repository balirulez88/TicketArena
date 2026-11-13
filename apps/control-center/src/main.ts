import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { parseConfig } from "./config";
import { createDashboardServer } from "./server";
import { takeSnapshot } from "./snapshot";
import { createSources } from "./sources";
import { buildState } from "./state";

// `.ralph/` exists only in the checkout where Ralph runs, normally the main one, while this app
// may run from a linked worktree. The common Git directory's parent is that main checkout.
function mainCheckout(): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      .toString()
      .trim();
    return basename(common) === ".git" ? dirname(common) : process.cwd();
  } catch {
    return process.cwd();
  }
}

function main(): void {
  const config = parseConfig(process.argv.slice(2), process.env, mainCheckout());
  const root = resolve(config.root);
  const sources = createSources(root);
  const server = createDashboardServer({
    refreshSeconds: config.refreshSeconds,
    load: () =>
      buildState(takeSnapshot(sources, { root, ref: config.ref, now: Date.now() }), config),
  });
  server.listen(config.port, config.host, () => {
    console.warn(
      `Ralph Control Center (read-only) on http://${config.host}:${config.port}/ reading ${root} at ${config.ref}`,
    );
  });
}

try {
  main();
} catch (error) {
  console.error(`control-center: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
