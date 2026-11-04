#!/usr/bin/env node
//
// The verifier's bin check (ADR 0015). It runs in the prepare stage right after `pnpm install`
// and before any package script, so it judges what the install linked before anything uses it:
//
//   node ralph-bins.mjs <workspace>      exit 0 clean, 1 with every problem listed
//
// pnpm links the bins of each project's direct dependencies into its node_modules/.bin, which
// comes first on PATH when that project's scripts run, and its shims run `$basedir/node` in place
// of node when there is one. The importer pins the toolchain's packages to the base's, but it
// cannot see bin names: a lockfile does not record them. So an ordinary dependency, or a new
// workspace package, that links a bin named `node`, `sh`, `tsc` or `vitest` would put the slice's
// code where the gate runs its trusted commands. So, in every project:
//
//   - no linked bin may be named like a command on the image's PATH, whoever declares it;
//   - no package outside the toolchain may declare a bin named like a toolchain command (a fixed
//     list, plus what the toolchain packages installed here declare);
//   - every linked bin named like a toolchain command must point into a toolchain package in
//     pnpm's store (node_modules/.pnpm/<key>/node_modules/<package>/), whoever declared it, so
//     whatever pnpm links that the manifest reading does not model is judged by what it runs.
//     pnpm names a shim's target in a `cmd-shim-target` comment; a slice cannot write under
//     node_modules (a host-only path), and a bin it cannot locate is refused;
//   - a direct dependency whose manifest cannot be read is refused.
//
// Dependency-free, and reads only manifests and directory listings: nothing it inspects is
// executed.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isToolchain, TOOLCHAIN_BINS } from "./ralph-toolchain.mjs";

const SKIP = new Set(["node_modules", ".git"]);
// Windows shims of a bin; the container has none, but the name is the bin's either way.
const binName = (file) => basename(file).replace(/\.(cmd|ps1)$/i, "");

/** A manifest as pnpm reads it (a byte order mark is allowed), or null. */
function readManifest(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
    return pkg !== null && typeof pkg === "object" && !Array.isArray(pkg) ? pkg : null;
  } catch {
    return null;
  }
}

/** Every file under a directory, however deep, as pnpm links a bin directory. */
function filesUnder(dir) {
  if (!(existsSync(dir) && statSync(dir).isDirectory())) {
    return [];
  }
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((path) => statSync(join(dir, path)).isFile());
}

/** The names a manifest declares as bins; a bin directory declares every file under it. */
export function declaredBins(dir, pkg) {
  const names = [];
  if (typeof pkg.bin === "string") {
    names.push(String(pkg.name ?? ""));
  } else if (pkg.bin !== null && typeof pkg.bin === "object") {
    names.push(...Object.keys(pkg.bin));
  }
  const binDir = pkg.directories?.bin;
  if (typeof binDir === "string") {
    names.push(...filesUnder(join(dir, binDir)));
  }
  return names.map(binName).filter(Boolean);
}

/** Every [name, directory] a project depends on directly, as pnpm linked it. */
function directDependencies(project) {
  const modules = join(project, "node_modules");
  if (!existsSync(modules)) {
    return [];
  }
  return readdirSync(modules)
    .filter((entry) => !entry.startsWith("."))
    .flatMap((entry) =>
      entry.startsWith("@")
        ? readdirSync(join(modules, entry)).map((name) => `${entry}/${name}`)
        : [entry],
    )
    .map((name) => [name, join(modules, name)]);
}

/** Workspace directories with a manifest, to a fixed depth. */
export function projects(root, depth = 3) {
  const found = existsSync(join(root, "package.json")) ? [root] : [];
  if (depth === 0) {
    return found;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name)) {
      found.push(...projects(join(root, entry.name), depth - 1));
    }
  }
  return found;
}

/** The commands on PATH outside any node_modules: what scripts and pnpm's shims rely on. */
export function systemCommands(path = process.env.PATH ?? "") {
  return path
    .split(delimiter)
    .filter((dir) => dir && !dir.includes("node_modules") && existsSync(dir))
    .flatMap((dir) => readdirSync(dir));
}

/** What a project's install linked: its direct dependencies with their bins, and its .bin. */
function installed(project) {
  const deps = directDependencies(project).map(([name, dir]) => {
    const pkg = readManifest(dir);
    return {
      project,
      name,
      readable: pkg !== null,
      bins: pkg === null ? [] : declaredBins(dir, pkg),
    };
  });
  const dir = join(project, "node_modules", ".bin");
  const linked = filesUnderBin(project).map((file) => ({
    bin: binName(file),
    target: shimTarget(join(dir, file)),
  }));
  return { project, deps, linked };
}

/**
 * What a linked bin runs: a symlink's real path, or the target pnpm's shim names (relative to
 * the shim's directory on Linux, absolute on Windows), as an absolute path; or null.
 */
function shimTarget(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return realpathSync(path);
    }
    const named = /^# cmd-shim-target=(.+)$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim();
    return named ? resolve(dirname(path), named) : null;
  } catch {
    return null;
  }
}

const slashes = (path) => posix.normalize(path.replace(/\\/g, "/"));

/** The toolchain package `target` lies in, in the workspace's store, or null. */
function storePackage(root, target) {
  const store = `${slashes(resolve(root))}/node_modules/.pnpm/`;
  const path = slashes(target);
  if (!path.startsWith(store)) {
    return null;
  }
  const name = /^[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path.slice(store.length))?.[1];
  return name !== undefined && isToolchain(name) ? name : null;
}
const filesUnderBin = (project) => {
  const dir = join(project, "node_modules", ".bin");
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** Problems with one project's linked bins: commands the gate trusts, run from elsewhere. */
function linkedProblems(root, project, linked, systemNames, toolchainBins) {
  const problems = [];
  for (const { bin, target } of linked) {
    if (systemNames.has(bin)) {
      problems.push(`${project}: pnpm linked the bin "${bin}", a command the gate trusts`);
    } else if (toolchainBins.has(bin) && target === null) {
      problems.push(`${project}: pnpm linked the bin "${bin}" to code it cannot locate`);
    } else if (toolchainBins.has(bin) && storePackage(root, target) === null) {
      problems.push(
        `${project}: pnpm linked the bin "${bin}" to ${target}, which is not a toolchain package`,
      );
    }
  }
  return problems;
}

/** Every problem with the bins the install linked, or an empty list. */
export function shadowingBins(root, system = systemCommands()) {
  const all = projects(root).map(installed);
  const deps = all.flatMap((entry) => entry.deps);
  const systemNames = new Set(system);
  const toolchainBins = new Set([
    ...TOOLCHAIN_BINS,
    ...deps.filter((dep) => isToolchain(dep.name)).flatMap((dep) => dep.bins),
  ]);
  const problems = deps
    .filter((dep) => !dep.readable)
    .map((dep) => `${dep.project}: ${dep.name}: its manifest cannot be read`);
  for (const dep of deps.filter((d) => !isToolchain(d.name))) {
    for (const bin of dep.bins.filter((name) => toolchainBins.has(name) || systemNames.has(name))) {
      problems.push(
        `${dep.project}: ${dep.name} declares the bin "${bin}", a command the gate trusts`,
      );
    }
  }
  for (const { project, linked } of all) {
    problems.push(...linkedProblems(root, project, linked, systemNames, toolchainBins));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = shadowingBins(process.argv[2] ?? ".");
  for (const problem of problems) {
    console.error(`[ralph-bins] ${problem}`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
