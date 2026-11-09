// Tests for scripts/ralph-bins.mjs, the verifier's bin check (ADR 0015, TD-058). Each test lays
// out an installed workspace as pnpm links it (a project's direct dependencies under its
// node_modules, packages in the store under node_modules/.pnpm, shims under node_modules/.bin
// that name their target) and runs the check's command line on it, as the prepare stage does.

import "./ralph-test-workspace.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ralph-bins.mjs", import.meta.url));
const write = (dir, path, value) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof value === "string" ? value : JSON.stringify(value));
};

/** Where pnpm's store puts `name`: node_modules/.pnpm/<key>/node_modules/<name>. */
const stored = (root, name) =>
  join(root, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", name);

/** A shim as pnpm writes it: a shell script that names its target in a comment. */
const shim = (target) => `#!/bin/sh\nexec node "${target}" "$@"\n# cmd-shim-target=${target}\n`;

/** Installs a dependency of `project` with `manifest`, and the bins pnpm linked for it. */
function install(root, project, manifest, linked = []) {
  const text = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
  const name = typeof manifest === "string" ? "evil" : manifest.name;
  write(root, `${project}/node_modules/${name}/package.json`, text);
  for (const bin of linked) {
    write(root, `${project}/node_modules/.bin/${bin}`, shim(join(stored(root, name), "bin.js")));
  }
}

/** A workspace with a root and packages/demo, both depending on the real test runner. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "ralph-bins-"));
  write(root, "package.json", { name: "root" });
  write(root, "packages/demo/package.json", { name: "demo" });
  for (const project of [".", "packages/demo"]) {
    install(root, project, { name: "vitest", bin: { vitest: "vitest.mjs" } }, ["vitest"]);
    install(root, project, { name: "typescript", bin: { tsc: "t", tsserver: "s" } }, [
      "tsc",
      "tsserver",
    ]);
  }
  // Commands on the image's PATH, as the check sees them.
  write(root, "system-bin/node", "");
  write(root, "system-bin/sh", "");
  return root;
}

function check(root) {
  const result = spawnSync(process.execPath, [script, root], {
    encoding: "utf8",
    env: { ...process.env, PATH: join(root, "system-bin") },
  });
  return { code: result.status, output: result.stderr };
}

describe("ralph-bins", () => {
  it("passes a workspace whose other packages' bins shadow nothing", () => {
    const root = workspace();
    install(root, "packages/demo", { name: "left-pad", bin: { "left-pad": "cli.js" } }, [
      "left-pad",
    ]);
    install(root, "packages/demo", { name: "@scope/tool", bin: "cli.js" }, ["tool"]);
    install(root, "packages/demo", { name: "nested", directories: { bin: "b" } }, ["deep"]);
    write(root, "packages/demo/node_modules/nested/b/sub/deep", "");
    // pnpm also links the bins of a dependency's peers: vite, for vitest. No direct dependency
    // declares it, and it points into the toolchain's own package.
    write(
      root,
      "packages/demo/node_modules/.bin/vite",
      shim(join(stored(root, "vite"), "bin", "vite.js")),
    );
    const result = check(root);
    assert.equal(result.code, 0, result.output);
  });

  it("resolves a shim's target relative to the shim, as pnpm writes it on Linux", () => {
    const root = workspace();
    const relative = "../../../../node_modules/.pnpm/vite@1.0.0/node_modules/vite/bin/vite.js";
    write(root, "packages/demo/node_modules/.bin/vite", shim(relative));
    assert.equal(check(root).code, 0, check(root).output);
    const escaping = "../../../../packages/evil/vite.js";
    write(root, "packages/demo/node_modules/.bin/vite", shim(escaping));
    assert.match(check(root).output, /pnpm linked the bin "vite" to .*, which is not a toolchain/);
  });

  for (const [name, manifest, linked] of [
    ["the node binary pnpm's shims run", { name: "evil", bin: { node: "x.sh" } }, "node"],
    ["the shell scripts run in", { name: "evil", bin: { sh: "x.sh" } }, "sh"],
    ["the type checker", { name: "evil", bin: { tsc: "x.js" } }, "tsc"],
    ["the test runner, as a bin string", { name: "@evil/vitest", bin: "x.js" }, "vitest"],
    ["a command from a bin directory", { name: "evil", directories: { bin: "b" } }, "tsserver"],
    // pnpm links every file under a bin directory, however deep, by its base name.
    ["node, deep in a bin directory", { name: "evil", directories: { bin: "b" } }, "node"],
    // pnpm reads a manifest with a byte order mark; so must the check.
    [
      "node, in a manifest with a byte order mark",
      '\uFEFF{"name":"evil","bin":{"node":"x"}}',
      "node",
    ],
  ]) {
    it(`refuses a package whose bin shadows ${name}`, () => {
      const root = workspace();
      install(root, "packages/demo", manifest, [linked]);
      write(root, "packages/demo/node_modules/evil/b/tsserver", "");
      write(root, "packages/demo/node_modules/evil/b/x/y/node", "");
      const result = check(root);
      assert.equal(result.code, 1, "refused");
      assert.match(result.output, new RegExp(`the bin "${linked}"`));
    });
  }

  it("refuses a toolchain command even where the slice dropped the package that provides it", () => {
    // packages/db's protected `db:generate` runs `prisma`. With prisma dropped and another
    // package linking a `prisma` bin, no toolchain package in the install says the name is
    // reserved: the list must come from the base, not from what the candidate installed.
    const root = workspace();
    install(root, "packages/demo", { name: "p", bin: { prisma: "x.js" } }, ["prisma"]);
    const result = check(root);
    assert.equal(result.code, 1, "refused");
    assert.match(result.output, /p declares the bin "prisma"/);
    assert.match(result.output, /pnpm linked the bin "prisma" to .*, which is not a toolchain/);
  });

  it("refuses a workspace package linked into another that shadows a command", () => {
    const root = workspace();
    // pnpm links a workspace dependency as a directory link; the manifest is the slice's.
    install(root, "packages/demo", { name: "@ticketarena/tool", bin: { node: "x.sh" } }, ["node"]);
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /the bin "node"/);
  });

  it("refuses a toolchain command linked to code outside the toolchain, whoever declared it", () => {
    // Whatever pnpm's bin discovery does that the check does not model, a toolchain command must
    // still point into a toolchain package: here a workspace package of the slice.
    const root = workspace();
    write(
      root,
      "packages/demo/node_modules/.bin/tsc",
      shim(join(root, "packages", "evil", "x.js")),
    );
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /pnpm linked the bin "tsc" to .*evil.*, which is not a toolchain/);
  });

  it("refuses a toolchain command whose shim does not say what it runs", () => {
    const root = workspace();
    write(root, "packages/demo/node_modules/.bin/vitest", "#!/bin/sh\nexec ./x\n");
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /pnpm linked the bin "vitest" to code it cannot locate/);
  });

  it("refuses a toolchain command that only looks like it points into the store", () => {
    const root = workspace();
    const target = `${stored(root, "vitest")}/../../../../packages/evil/x.js`;
    write(root, "packages/demo/node_modules/.bin/vitest", shim(target));
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /pnpm linked the bin "vitest" to .*, which is not a toolchain/);
  });

  it("refuses a dependency whose manifest it cannot read", () => {
    const root = workspace();
    install(root, "packages/demo", "{not json");
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /evil: its manifest cannot be read/);
  });

  it("checks the root project too", () => {
    const root = workspace();
    install(root, ".", { name: "evil", bin: { tsc: "x.js" } }, ["tsc"]);
    assert.equal(check(root).code, 1);
  });
});
