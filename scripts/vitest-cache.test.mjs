// Regression test for the intermittent Windows startup failure
//   ENOTEMPTY: directory not empty, rmdir '<repo>\node_modules\.vitest-cache'
//
// Vitest 5 enables `fsModuleCache` by default and puts it in ONE directory at the workspace root,
// shared by every project. When the lockfile hash in its `_metadata.json` is stale (after any
// dependency change), each Vitest process `rm -rf`s that directory at startup. Turbo starts one
// Vitest process per package in parallel, so they delete and refill the same directory at once;
// on Windows, where a file another process holds open is only marked for deletion, the rmdir
// fails. Reproduced locally: 8 of 36 parallel starts failed with a stale hash.
//
// The fix keeps both the cache and the parallelism: every package resolves its own cache
// directory, so no two Turbo tasks ever share one. This test resolves each package's real Vitest
// config through Vitest's own API and fails if any package falls back to the shared root cache.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every workspace package whose `test` script runs Vitest (pnpm-workspace.yaml: apps/*, packages/*).
function vitestPackages() {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, group, entry.name))
      .filter((dir) => {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          return /\bvitest\b/.test(pkg.scripts?.test ?? "");
        } catch {
          return false;
        }
      }),
  );
}

async function resolvedCachePath(dir) {
  const require = createRequire(join(dir, "package.json"));
  const { resolveConfig } = await import(pathToFileURL(require.resolve("vitest/node")).href);
  const { test: resolved } = await resolveConfig({ root: dir, run: true, watch: false });
  // Vite normalizes paths to forward slashes, also on Windows.
  return { enabled: resolved.fsModuleCache, path: resolve(resolved.fsModuleCachePath ?? root) };
}

test("every Vitest package has its own fsModuleCache directory inside the package", async () => {
  const packages = vitestPackages();
  assert.ok(packages.length >= 2, "expected several Vitest packages in the workspace");
  const seen = new Map();
  for (const dir of packages) {
    const name = relative(root, dir);
    const { enabled, path } = await resolvedCachePath(dir);
    // A disabled cache would also avoid the race, but by giving up the cache: not the fix.
    assert.equal(enabled, true, `${name}: fsModuleCache must stay enabled`);
    assert.ok(
      path.startsWith(`${dir}${sep}`),
      `${name}: fsModuleCachePath must be inside the package (got '${path === root ? "the shared workspace-root default" : path}'); set fsModuleCachePath in its vitest.config.ts`,
    );
    assert.ok(!seen.has(path), `${name} shares its cache directory with ${seen.get(path)}`);
    seen.set(path, name);
  }
});
