// The toolchain (ADR 0015): packages whose code runs in a trusted role when the host verifies a
// slice. That is the Vitest main process that reports the verdict, the bundler and CSS tooling it
// loads, the type checker, the linter, the task runner, the Prisma generator, and the shared test
// infrastructure whose global setup runs inside Vitest's main process. Every dependency of the
// root manifest (the repository's tooling) and of the test infrastructure counts as well.
//
// Shared by the host importer (scripts/ralph-accept.mjs), which pins the toolchain's locked
// closure to the base's, and the verifier's bin check (scripts/ralph-bins.mjs), which keeps other
// packages from shadowing its commands. Dependency-free: the sandbox image runs it before any
// package is trusted.

export const TOOLCHAIN = [
  "@ticketarena/test-infra",
  "vitest",
  "vite",
  "typescript",
  "turbo",
  "prisma",
  "esbuild",
  "tsx",
  "jiti",
  "yaml",
  "postcss",
  "tailwindcss",
  "autoprefixer",
  "lightningcss",
  "sass",
  "sass-embedded",
  "less",
  "stylus",
];
export const TOOLCHAIN_SCOPES = [
  "@vitest/",
  "@biomejs/",
  "@prisma/",
  "@turbo/",
  "@esbuild/",
  "@tailwindcss/",
  "@rolldown/",
];
/** Workspace projects all of whose dependencies are toolchain. */
export const TOOLCHAIN_IMPORTERS = [".", "packages/test-infra"];

/**
 * The commands the toolchain links, by name. Fixed here, on the base, rather than read from a
 * candidate's install: a slice that drops the package providing one (say `prisma` from
 * packages/db) must not free its name for a bin of its own, which the base's scripts would run.
 */
export const TOOLCHAIN_BINS = [
  "vitest",
  "vite",
  "tsc",
  "tsserver",
  "turbo",
  "biome",
  "prisma",
  "esbuild",
  "tsx",
  "jiti",
  "yaml",
  "postcss",
  "tailwindcss",
  "lightningcss",
  "autoprefixer",
  "sass",
  "lessc",
  "stylus",
  "pnpm",
  "pnpx",
  "npm",
  "npx",
  "corepack",
];

export const isToolchain = (name) =>
  TOOLCHAIN.includes(name) || TOOLCHAIN_SCOPES.some((scope) => name.startsWith(scope));
