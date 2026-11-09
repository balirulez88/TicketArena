import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadedSpecifiers, lockedSpecifiers, tokenize } from "./ralph-preflight.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ralph-preflight.mjs");
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  const run = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const manifest = (name, fields = {}) =>
  `${JSON.stringify({ name, scripts: { test: "vitest run" }, ...fields }, null, 2)}\n`;

// The shape that cost ticket 54 a run: one package declares a driver, a sibling does not.
const WORKSPACE = {
  "package.json": `${JSON.stringify({ name: "root", devDependencies: { typescript: "6.0.3" } })}\n`,
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - apps/*\n",
  "pnpm-lock.yaml": [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  packages/driver-owner:",
    "    dependencies:",
    "      driver:",
    "        specifier: 1.2.0",
    "        version: 1.2.0",
    "",
    "packages:",
    "",
    "  driver@1.2.0: {}",
    "",
  ].join("\n"),
  "packages/driver-owner/package.json": manifest("@demo/driver-owner", {
    dependencies: { driver: "1.2.0" },
  }),
  "packages/driver-owner/src/index.ts": "export const owner = 1;\n",
  "packages/service/package.json": manifest("@demo/service", {
    dependencies: { "@demo/driver-owner": "workspace:*" },
    devDependencies: { vitest: "5.0.5" },
  }),
  "packages/service/src/index.ts": "export const service = 1;\n",
  "packages/service/tsconfig.json":
    '{\n  // comment\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n',
};

function repo(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));
  dirs.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  write(root, { ...WORKSPACE, ...extra });
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function run(cwd, ...args) {
  return spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function imports(root, base, source, path = "packages/service/src/thing.test.ts") {
  write(root, { [path]: source });
  return run(root, "imports", "--base", base);
}

describe("loadedSpecifiers", () => {
  const cases = [
    ["default import", `import a from "x";`, ["x"]],
    ["named import over lines", `import {\n  a,\n  b as c,\n} from 'x'`, ["x"]],
    ["side effect", `import "x";`, ["x"]],
    ["namespace", `import * as a from "x";`, ["x"]],
    ["re-export", `export { a } from "x";`, ["x"]],
    ["star re-export", `export * from "x";`, ["x"]],
    ["named star re-export", `export * as y from "x";`, ["x"]],
    ["export without source", `export { a };\nconst from = "x";`, []],
    ["import type is erased", `import type { A } from "x";`, []],
    ["import type default is erased", `import type A from "x";`, []],
    ["export type is erased", `export type { A } from "x";`, []],
    ["a value named type is not", `import type from "x";`, ["x"]],
    ["a value named type, with names", `import type, { a } from "x";`, ["x"]],
    ["inline type still loads the module", `import { type A } from "x";`, ["x"]],
    ["a binding named from", `import { from } from "x";`, ["x"]],
    ["top-level dynamic import", `const a = await import("x");`, ["x"]],
    ["top-level require", `const a = require("x");`, ["x"]],
    ["import equals", `import a = require("x");`, ["x"]],
    [
      "import inside a test body fails inside the test",
      `test("t", async () => { await import("x"); });`,
      [],
    ],
    ["dynamic expression", `await import(name);`, []],
    ["import.meta", `const a = import.meta.url;`, []],
    ["line comment", `// import a from "x";\nimport "y";`, ["y"]],
    ["block comment", `/* import a from "x"; */ import "y";`, ["y"]],
    ["string", `const a = 'import b from "x"';`, []],
    ["template", 'const a = `import b from "x"`;', []],
    ["template expression", `const a = \`\${f("}")}\`; import "y";`, ["y"]],
    ["nested template", `const a = \`\${\`\${"x"}\`}\`; import "y";`, ["y"]],
    ["regex with quote", `const a = /["']/; import "y";`, ["y"]],
    ["regex with slash in class", `const a = /[/"]/g; import "y";`, ["y"]],
    ["division is not a regex", `const a = b / c; import "y"; const d = e / f;`, ["y"]],
    ["jsx apostrophe costs one line at most", `const a = <p>don't</p>;\nimport "y";`, ["y"]],
    ["ambient module", `declare module "m" { import a from "x"; }`, []],
    ["a method called import", `a.import("x"); a.require("y");`, []],
  ];
  for (const [name, source, expected] of cases) {
    test(name, () => assert.deepEqual(loadedSpecifiers(source), expected));
  }

  test("tokens carry their nesting depth", () => {
    assert.deepEqual(
      tokenize("{ a }").map((t) => [t.text, t.depth]),
      [
        ["{", 0],
        ["a", 1],
        ["}", 0],
      ],
    );
  });
});

describe("imports: what the base cannot load is found", () => {
  test("a package only a sibling declares (ticket 54), naming who does", () => {
    const { root, base } = repo();
    const result = imports(root, base, `import { driverConfig } from "driver";\n`);
    assert.equal(result.status, 5);
    assert.match(result.stdout, /^NEEDS PREPARATION/);
    assert.match(result.stdout, /packages\/service does not declare/);
    assert.match(result.stdout, /declares it in packages\/driver-owner/);
  });

  test("adding the dependency in the run does not hide it: the base is what counts", () => {
    const { root, base } = repo();
    write(root, {
      "packages/service/package.json": manifest("@demo/service", {
        dependencies: { "@demo/driver-owner": "workspace:*", driver: "1.2.0" },
      }),
    });
    const result = imports(root, base, `import "driver";\n`);
    assert.equal(result.status, 5);
    assert.match(result.stdout, /does not declare on the base/);
  });

  test("a package no one declares", () => {
    const { root, base } = repo();
    const result = imports(root, base, `import "brand-new";\n`);
    assert.equal(result.status, 5);
    assert.match(result.stdout, /no package on the base declares it/);
  });

  test("a workspace package the owner does not declare", () => {
    const { root, base } = repo();
    const result = imports(
      root,
      base,
      `import "@demo/service";\n`,
      "packages/driver-owner/src/a.test.ts",
    );
    assert.equal(result.status, 5);
    assert.match(result.stdout, /"@demo\/service"/);
  });

  test("a helper that is not carried into the proof", () => {
    const { root, base } = repo();
    write(root, { "packages/service/src/helper.ts": "export const h = 1;\n" });
    const result = imports(root, base, `import { h } from "./helper";\n`);
    assert.equal(result.status, 5);
    assert.match(result.stdout, /\.\/helper/);
    assert.match(result.stdout, /__fixtures__/);
  });

  test("an import in a carried fixture", () => {
    const { root, base } = repo();
    const result = imports(
      root,
      base,
      `import "driver";\n`,
      "packages/service/src/__fixtures__/f.ts",
    );
    assert.equal(result.status, 5);
  });

  test("a test in a package the base lacks", () => {
    const { root, base } = repo();
    write(root, { "packages/new/package.json": manifest("@demo/new") });
    const result = imports(root, base, `import "vitest";\n`, "packages/new/src/a.test.ts");
    assert.equal(result.status, 5);
    assert.match(result.stdout, /not inside a workspace package/);
    assert.equal(result.stdout.match(/^- /gm).length, 1);
  });

  test("an alias whose target the base lacks", () => {
    const { root, base } = repo();
    const result = imports(root, base, `import "@/missing";\n`);
    assert.equal(result.status, 5);
  });
});

describe("imports: no false positives", () => {
  const clean = [
    ["a declared devDependency", `import { test } from "vitest";\n`],
    ["a declared workspace package", `import { owner } from "@demo/driver-owner";\n`],
    ["the package's own name", `import { service } from "@demo/service";\n`],
    ["a root dependency (resolution walks up)", `import ts from "typescript";\n`],
    ["a subpath of a declared package", `import "vitest/config";\n`],
    ["a node: builtin", `import { readFileSync } from "node:fs";\n`],
    ["a bare builtin and its subpath", `import "fs";\nimport "fs/promises";\n`],
    ["a virtual module", `import "virtual:thing";\n`],
    ["a package-internal import", `import "#internal";\n`],
    ["a module on the base", `import { service } from "./index";\n`],
    ["a module on the base, by emitted name", `import { service } from "./index.js";\n`],
    ["a directory with an index", `import { service } from "../src";\n`],
    ["a query suffix", `import a from "./index.ts?raw";\n`],
    ["a tsconfig alias to the base", `import { service } from "@/index";\n`],
    ["an undeclared type-only import", `import type { A } from "driver";\n`],
    ["an undeclared import inside a test", `test("t", async () => { await import("driver"); });\n`],
  ];
  for (const [name, source] of clean) {
    test(name, () => {
      const { root, base } = repo();
      const result = imports(root, base, source);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stdout, "READY\n");
    });
  }

  test("a carried fixture imported by a test", () => {
    const { root, base } = repo();
    write(root, { "packages/service/src/__fixtures__/f.ts": "export const f = 1;\n" });
    assert.equal(imports(root, base, `import { f } from "./__fixtures__/f";\n`).status, 0);
  });

  test("a non-test source file is not carried, so its imports are not judged here", () => {
    const { root, base } = repo();
    assert.equal(
      imports(root, base, `import "brand-new";\n`, "packages/service/src/impl.ts").status,
      0,
    );
  });

  test("a repository without pnpm workspaces is judged by its root manifest alone", () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-"));
    dirs.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    write(root, { "package.json": `${JSON.stringify({ devDependencies: { vitest: "1" } })}\n` });
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    assert.equal(imports(root, base, `import "vitest";\n`, "a.test.ts").status, 0);
    assert.equal(imports(root, base, `import "other";\n`, "a.test.ts").status, 5);
  });
});

describe("imports: an exact candidate, and the lockfile", () => {
  test("judges the candidate's objects, not the working tree", () => {
    const { root, base } = repo();
    write(root, { "packages/service/src/a.test.ts": `import "driver";\n` });
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "candidate");
    const candidate = git(root, "rev-parse", "HEAD");
    write(root, { "packages/service/src/a.test.ts": `import "vitest";\n` });
    assert.equal(run(root, "imports", "--base", base, "--candidate", candidate).status, 5);
    assert.equal(run(root, "imports", "--base", base).status, 0);
  });

  test("a deleted test is not judged", () => {
    const { root, base } = repo({ "packages/service/src/old.test.ts": `import "driver";\n` });
    rmSync(join(root, "packages/service/src/old.test.ts"));
    assert.equal(run(root, "imports", "--base", base).status, 0);
  });

  test("a manifest change the lockfile does not carry", () => {
    const { root, base } = repo();
    write(root, {
      "packages/driver-owner/package.json": manifest("@demo/driver-owner", {
        dependencies: { driver: "1.3.0" },
      }),
    });
    const result = run(root, "imports", "--base", base);
    assert.equal(result.status, 5);
    assert.match(result.stdout, /disagrees with pnpm-lock.yaml on driver/);
  });

  test("a manifest change the lockfile carries", () => {
    const { root, base } = repo();
    write(root, {
      "packages/driver-owner/package.json": manifest("@demo/driver-owner", {
        dependencies: { driver: "1.3.0" },
      }),
      "pnpm-lock.yaml": readFileSync(join(root, "pnpm-lock.yaml"), "utf8").replace(
        "specifier: 1.2.0",
        "specifier: 1.3.0",
      ),
    });
    assert.equal(run(root, "imports", "--base", base).status, 0);
  });

  test("lockedSpecifiers reads quoted names and root importers", () => {
    const lock =
      "importers:\n\n  .:\n    devDependencies:\n      '@a/b':\n        specifier: ^1.0.0\n        version: 1.0.0\n\npackages:\n\n  x: {}\n";
    assert.equal(lockedSpecifiers(lock).get(".").get("@a/b"), "^1.0.0");
  });

  // What the repository's own lockfile looks like: pnpm locks itself in a document of its own.
  const inTwoDocuments = (lock) =>
    `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.15.0\n        version: 12.15.0\n\n---\n${lock}`;

  test("a lockfile of two YAML documents is read from the workspace's", () => {
    const { root, base } = repo();
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const importers = lockedSpecifiers(inTwoDocuments(lock));
    assert.equal(importers.get("packages/driver-owner").get("driver"), "1.2.0");
    write(root, {
      "pnpm-lock.yaml": inTwoDocuments(lock.replace("specifier: 1.2.0", "specifier: 1.3.0")),
      "packages/driver-owner/package.json": manifest("@demo/driver-owner", {
        dependencies: { driver: "1.3.0" },
      }),
    });
    assert.equal(run(root, "imports", "--base", base).status, 0);
  });
});

describe("imports --hook", () => {
  const hook = (root, base) =>
    spawnSync("node", [SCRIPT, "imports", "--hook", "--root", root], {
      encoding: "utf8",
      env: { ...process.env, RALPH_BASE_SHA: base ?? "" },
    });

  test("outside a harness run it does nothing", () => {
    const { root } = repo();
    write(root, { "packages/service/src/a.test.ts": `import "driver";\n` });
    const result = hook(root);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  test("a new finding goes back to the agent once, and a changed one again", () => {
    const { root, base } = repo();
    write(root, { "packages/service/src/a.test.ts": `import "driver";\n` });
    const first = hook(root, base);
    assert.equal(first.status, 2);
    assert.match(first.stderr, /cannot pass the harness's checks against the base/);
    assert.match(first.stderr, /Fix:/);
    assert.equal(hook(root, base).status, 0);
    write(root, { "packages/service/src/b.test.ts": `import "brand-new";\n` });
    assert.equal(hook(root, base).status, 2);
  });

  test("records every firing, and stays quiet when there is nothing to report", () => {
    const { root, base } = repo();
    assert.equal(hook(root, base).status, 0);
    assert.equal(hook(root, base).status, 0);
    const log = readFileSync(join(root, ".ralph/lead/preflight-hook.log"), "utf8");
    assert.equal(log.trim().split("\n").length, 2);
  });

  test("a check that cannot run never breaks the session", () => {
    const { root } = repo();
    const result = hook(root, "0".repeat(40));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /could not run/);
  });
});

// Only the project's settings fire for an Implementer subagent in the sandbox; hooks in the agent's
// frontmatter were measured not to, and `pnpm run format` rewrites that frontmatter too (ADR 0019).
describe("the hook's installation", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  test("the project settings run the check after every kind of edit", () => {
    const settings = JSON.parse(readFileSync(join(repoRoot, ".claude/settings.json"), "utf8"));
    const [entry] = settings.hooks.PostToolUse;
    assert.deepEqual(entry.matcher.split("|").sort(), ["Bash", "Edit", "Write"]);
    assert.match(entry.hooks[0].command, /ralph-preflight\.mjs" imports --hook --root/);
  });

  test("the Implementer's definition does not carry a hook that would not fire", () => {
    const agent = readFileSync(join(repoRoot, ".claude/agents/ticketarena-implementer.md"), "utf8");
    assert.doesNotMatch(agent.split("---")[1], /^hooks:/m);
  });
});

describe("the check itself failing", () => {
  test("exits 2, which the driver treats as a stop", () => {
    const { root } = repo();
    const result = run(root, "imports", "--base", "0".repeat(40));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not run/);
  });
});

describe("ticket", () => {
  const ticket = (root, base, criteria, name = "issues/01-demo.md") => {
    write(root, { [name]: `# 01: Demo\n\n${criteria}\n` });
    return run(root, "ticket", name, "--base", base);
  };

  test("a documentation criterion with no test", () => {
    const { root, base } = repo();
    const result = ticket(root, base, "- [ ] The limit is documented in `docs/limits.md`.");
    assert.equal(result.status, 5);
    assert.match(result.stdout, /Documentation deliverable/);
  });

  test("a criterion that only says what a docs directory records (ticket 56's AC6)", () => {
    const { root, base } = repo();
    const result = ticket(root, base, "- [ ] `docs/` records where the limit is read and why.");
    assert.equal(result.status, 5);
  });

  test("a criterion that names its test, even one mentioning a document", () => {
    const { root, base } = repo();
    assert.equal(
      ticket(root, base, "- [ ] A test asserts `docs/limits.md` lists the limit.").status,
      0,
    );
  });

  test("documentation requirements outside the criteria", () => {
    const { root, base } = repo();
    assert.equal(
      ticket(root, base, "**Documentation deliverable:**\n- `docs/limits.md` records it.").status,
      0,
    );
  });

  test("a behaviour criterion with an aside about documentation (ticket 13)", () => {
    const { root, base } = repo();
    assert.equal(
      ticket(root, base, "- [ ] Releasing does not free the slot (documented; see ticket 30).")
        .status,
      0,
    );
  });

  const register = (...entries) =>
    `# Register\n\n<!-- ralph-debt:begin -->\n${entries.join("\n")}\n<!-- ralph-debt:end -->\n`;
  const entry = (id, title, status, impact = "None.") =>
    `### ${id}: ${title}\n\n- **Status:** ${status}\n- **Impact:** ${impact}\n`;

  test("open entries about flaky tests are noted and do not change the verdict", () => {
    const { root, base } = repo({
      "docs/technical-debt.md": register(
        entry("TD-001", "Slow query", "OPEN"),
        entry("TD-002", "Worker race", "PLANNED", "The test can flake on a slow machine."),
        entry("TD-003", "Old flaky test", "RESOLVED"),
      ),
    });
    const result = ticket(root, base, "- [ ] A test passes.");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^READY\nNote: .*mentions flakiness in TD-002: Worker race\n$/);
  });

  test("a repository without a debt register has no notes", () => {
    const { root, base } = repo();
    assert.equal(ticket(root, base, "- [ ] A test passes.").stdout, "READY\n");
  });

  test("a workspace package the base lacks", () => {
    const { root, base } = repo();
    const result = ticket(root, base, "- [ ] A test of `packages/new/src/a.ts` passes.");
    assert.equal(result.status, 5);
    assert.match(result.stdout, /packages\/new/);
  });

  test("an existing workspace package and non-path backticks", () => {
    const { root, base } = repo();
    assert.equal(
      ticket(root, base, "- [ ] A test of `packages/service/src/a.ts` and `packages/*` passes.")
        .status,
      0,
    );
  });
});

describe("baseline-key", () => {
  const key = (root, commit) =>
    run(
      root,
      "baseline-key",
      "--commit",
      commit,
      "--exclude",
      "issues/",
      "--exclude",
      "docs/debt.md",
    ).stdout;

  function advance(root, files) {
    write(root, files);
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "next");
    return git(root, "rev-parse", "HEAD");
  }

  test("stays the same when only excluded records move", () => {
    const { root, base } = repo();
    assert.equal(
      key(root, base),
      key(root, advance(root, { "issues/01.md": "x", "docs/debt.md": "y" })),
    );
  });

  test("changes with the code, and with a document that is not excluded", () => {
    const { root, base } = repo();
    const code = advance(root, { "packages/service/src/index.ts": "export const service = 2;\n" });
    assert.notEqual(key(root, base), key(root, code));
    assert.notEqual(key(root, code), key(root, advance(root, { "docs/other.md": "z" })));
  });
});
