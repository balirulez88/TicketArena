#!/usr/bin/env node
//
// Readiness checks for a ticket (ADR 0019): the deterministic, model-free questions whose answer
// is otherwise learned only after a paid implementation session. It decides nothing about merging.
// RED (scripts/ralph-red.mjs), the importer and the host's review stay the only judges; a finding
// here can only stop a run early, with the work kept.
//
// The check that matters most is `imports`. RED applies only the candidate's test files to the
// base, so a test may load only what the BASE provides. Every other check an agent can run sees
// the working tree, where a dependency it just added exists, so this one reads the base from git.
//
//   ralph-preflight.mjs imports --base <sha> [--candidate <sha>] [--root <dir>]
//       the candidate's test files (or the working tree's) against the base
//   ralph-preflight.mjs imports --hook [--root <dir>]
//       the same as a Claude Code hook: RALPH_BASE_SHA names the base, and a new finding goes back
//       to the agent that caused it. Outside a harness run it does nothing.
//   ralph-preflight.mjs ticket <file> --base <sha> [--root <dir>]
//       criteria only a reader can verify, and workspace packages the base does not have
//   ralph-preflight.mjs baseline-key --commit <rev> [--exclude <path>]... [--root <dir>]
//       a key for "the same code as an already verified commit"
//
// Exit codes: 0 READY; 5 NEEDS PREPARATION (findings on stdout); 2 the check could not run;
// --hook: 2 feedback for the agent, otherwise 0 (a broken hook must never break the session, the
// check before RED is the one that is mandatory).
//
// No dependencies, on purpose: it runs on every tool call of a session and in any repository.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { planRun, workspaceGlobs } from "./ralph-red.mjs";

const env = process.env;
const NEEDS_PREPARATION = 5;
const CANNOT_RUN = 2;
const HOOK_FEEDBACK = 2;
// Exactly what the driver carries into the RED proof (lead_prove_red in scripts/ralph-lead.sh).
const CARRIED = /\.test\.tsx?$|(^|\/)__fixtures__\//;
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const LOCKED_FIELDS = DEPENDENCY_FIELDS.filter((field) => field !== "peerDependencies");

// --- Which modules a file loads ------------------------------------------------------------------

// Words after which a `/` starts a regular expression, not a division.
const BEFORE_REGEX = new Set(
  "return typeof instanceof in of void delete throw new case do else yield await".split(" "),
);
const WORD = /[\p{ID_Start}$_][\p{ID_Continue}$]*/uy;
const NUMBER = /[0-9][\w.]*/y;

const pushToken = (s, type, text) => s.tokens.push({ type, text, depth: s.depth });

function regexAllowed(s) {
  const last = s.tokens.at(-1);
  if (!last) {
    return true;
  }
  if (last.type === "word") {
    return BEFORE_REGEX.has(last.text);
  }
  return last.type === "punct" && !/[)\]}]/.test(last.text);
}

// Continues a template at `from`: to its end, or into a `${`, whose `}` resumes it (scanClose).
function readTemplate(s, from) {
  const { text } = s;
  let j = from;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
    } else if (text[j] === "`") {
      pushToken(s, "value", "`");
      s.i = j + 1;
      return;
    } else if (text[j] === "$" && text[j + 1] === "{") {
      s.templates.push(s.depth);
      s.depth += 1;
      pushToken(s, "punct", "${");
      s.i = j + 2;
      return;
    } else {
      j += 1;
    }
  }
  s.i = j;
}

// The index after the expression, or -1 when this `/` closes on no line: a division after all.
function regexEnd(text, from) {
  let inClass = false;
  for (let j = from; j < text.length && text[j] !== "\n"; j += 1) {
    const char = text[j];
    if (char === "\\") {
      j += 1;
    } else if (char === "[" || char === "]") {
      inClass = char === "[";
    } else if (char === "/" && !inClass) {
      return j + 1;
    }
  }
  return -1;
}

function scanSpace(s) {
  if (!/\s/.test(s.text[s.i])) {
    return false;
  }
  s.i += 1;
  return true;
}

function scanComment(s) {
  const opener = s.text.slice(s.i, s.i + 2);
  if (opener !== "//" && opener !== "/*") {
    return false;
  }
  const end = opener === "//" ? s.text.indexOf("\n", s.i) : s.text.indexOf("*/", s.i + 2);
  if (end < 0) {
    s.i = s.text.length;
  } else {
    s.i = opener === "//" ? end : end + 2;
  }
  return true;
}

function scanString(s) {
  const quote = s.text[s.i];
  if (quote !== '"' && quote !== "'") {
    return false;
  }
  const { text } = s;
  let j = s.i + 1;
  let value = "";
  while (j < text.length && text[j] !== quote && text[j] !== "\n") {
    if (text[j] === "\\") {
      value += text[j + 1] ?? "";
      j += 2;
    } else {
      value += text[j];
      j += 1;
    }
  }
  if (text[j] === quote) {
    pushToken(s, "string", value);
    j += 1;
  }
  s.i = j;
  return true;
}

function scanTemplate(s) {
  if (s.text[s.i] !== "`") {
    return false;
  }
  readTemplate(s, s.i + 1);
  return true;
}

function scanRegex(s) {
  if (s.text[s.i] !== "/" || !regexAllowed(s)) {
    return false;
  }
  const end = regexEnd(s.text, s.i + 1);
  if (end < 0) {
    return false;
  }
  s.i = end;
  pushToken(s, "value", "/");
  return true;
}

function scanPattern(s, pattern, type) {
  pattern.lastIndex = s.i;
  const match = pattern.exec(s.text)?.[0];
  if (!match) {
    return false;
  }
  pushToken(s, type, match);
  s.i += match.length;
  return true;
}
const scanWord = (s) => scanPattern(s, WORD, "word");
const scanNumber = (s) => scanPattern(s, NUMBER, "value");

function scanClose(s) {
  if (s.text[s.i] !== "}" || s.templates.at(-1) !== s.depth - 1) {
    return false;
  }
  s.templates.pop();
  s.depth -= 1;
  readTemplate(s, s.i + 1);
  return true;
}

function scanPunct(s) {
  const char = s.text[s.i];
  if (")]}".includes(char)) {
    s.depth = Math.max(0, s.depth - 1);
  }
  pushToken(s, "punct", char);
  if ("([{".includes(char)) {
    s.depth += 1;
  }
  s.i += 1;
  return true;
}

const SCANNERS = [
  scanSpace,
  scanComment,
  scanString,
  scanTemplate,
  scanRegex,
  scanWord,
  scanNumber,
  scanClose,
  scanPunct,
];

/**
 * A minimal JS/TS tokenizer: strings, words and punctuation with their nesting depth, with
 * comments, templates and regular expressions out of the way. A string ends at the line's end at
 * the latest, so an apostrophe in JSX text can cost at most that line.
 */
export function tokenize(text) {
  // templates: the brace depth at which each open `${` closes.
  const state = { text, i: 0, depth: 0, templates: [], tokens: [] };
  while (state.i < text.length) {
    SCANNERS.some((scan) => scan(state));
  }
  return state.tokens;
}

const isString = (t, k) => t[k]?.type === "string";
const isWord = (t, k, word) => t[k]?.type === "word" && t[k].text === word;
const isPunct = (t, k, char) => t[k]?.type === "punct" && t[k].text === char;
const fromAt = (t, k) => (isWord(t, k, "from") && isString(t, k + 1) ? t[k + 1].text : undefined);

function afterBraces(t, k) {
  let j = k + 1;
  while (j < t.length && !(isPunct(t, j, "}") && t[j].depth === t[k].depth)) {
    j += 1;
  }
  return j + 1;
}

function importClauseSource(t, start) {
  for (let j = start; j < t.length && !isPunct(t, j, ";"); j += 1) {
    if (t[j].depth === 0) {
      const source = fromAt(t, j);
      if (source !== undefined) {
        return source;
      }
      if (j > start && (isWord(t, j, "import") || isWord(t, j, "export"))) {
        return undefined;
      }
    }
  }
  return undefined;
}

function importSource(t, k) {
  if (isString(t, k + 1)) {
    return t[k + 1].text;
  }
  if (isPunct(t, k + 1, "(")) {
    return isString(t, k + 2) ? t[k + 2].text : undefined;
  }
  if (isPunct(t, k + 1, ".")) {
    return undefined;
  }
  // `import type from "x"` and `import type, { a } from "x"` bind a value named `type`.
  const typeOnly =
    isWord(t, k + 1, "type") && !isPunct(t, k + 2, ",") && fromAt(t, k + 2) === undefined;
  return typeOnly ? undefined : importClauseSource(t, k + 1);
}

function exportSource(t, k) {
  if (isPunct(t, k + 1, "{")) {
    return fromAt(t, afterBraces(t, k + 1));
  }
  if (isPunct(t, k + 1, "*")) {
    return fromAt(t, isWord(t, k + 2, "as") ? k + 4 : k + 2);
  }
  return undefined;
}

const requireSource = (t, k) =>
  isPunct(t, k + 1, "(") && isString(t, k + 2) ? t[k + 2].text : undefined;

const SOURCES = new Map([
  ["import", importSource],
  ["export", exportSource],
  ["require", requireSource],
]);

/**
 * The specifiers a file loads while it is being imported: a miss among these is a load failure,
 * which RED rejects. Imports inside functions are left out: they fail inside a test, which RED
 * accepts. `import type` and `export type` are erased. `import { type A } from "x"` is not: under
 * verbatimModuleSyntax it still loads "x", so it counts.
 */
export function loadedSpecifiers(text) {
  const t = tokenize(text);
  const out = [];
  t.forEach((token, k) => {
    const read = token.type === "word" && token.depth === 0 ? SOURCES.get(token.text) : undefined;
    const source = read && !isPunct(t, k - 1, ".") ? read(t, k) : undefined;
    if (source !== undefined) {
      out.push(source);
    }
  });
  return out;
}

// --- The base, read from git ----------------------------------------------------------------------

function git(root, ...args) {
  const run = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(run.stderr ?? run.error ?? "").toString().trim()}`,
    );
  }
  return run.stdout;
}
const gitList = (root, ...args) =>
  git(root, ...args)
    .split("\0")
    .filter(Boolean);
const show = (root, rev, path) => {
  const run = spawnSync("git", ["-C", root, "show", `${rev}:${path}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : null;
};

function baseView(root, base) {
  const files = new Set(gitList(root, "ls-tree", "-r", "-z", "--name-only", base));
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) {
      cache.set(path, files.has(path) ? show(root, base, path) : null);
    }
    return cache.get(path);
  };
  const manifests = [...files].filter((path) => posix.basename(path) === "package.json");
  const manifest = (path) => JSON.parse(read(path) ?? "{}");
  const declared = (path) => {
    const pkg = manifest(path);
    return new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
  };
  return { sha: base, files, read, manifests, manifest, declared };
}

// The base as ralph-red.mjs's own planRun reads a working tree, so both apply the same rule.
const plannerIo = (root, view) => {
  const toRepo = (path) => relative(root, path).split(sep).join("/");
  return {
    root,
    exists: (path) => view.files.has(toRepo(path)),
    readText: (path) => view.read(toRepo(path)) ?? "",
  };
};

// --- Judging one file against the base ------------------------------------------------------------

const BUILTIN = new Set(builtinModules);
const packageName = (spec) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");
const RESOLVED_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

function ownerOf(file, view) {
  for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) {
    if (view.files.has(`${dir}/package.json`)) {
      return dir;
    }
  }
  return null;
}

// `compilerOptions.paths` of the owning package, read tolerantly (tsconfig allows comments).
function aliases(owner, view) {
  const text = view.read(owner ? `${owner}/tsconfig.json` : "tsconfig.json") ?? "";
  const section = /"paths"\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  return [...section.matchAll(/"([^"]+)"\s*:\s*\[\s*"([^"]+)"/g)].map((m) => ({
    pattern: m[1],
    target: m[2],
  }));
}

function aliasTarget(spec, owner, view) {
  for (const { pattern, target } of aliases(owner, view)) {
    const star = pattern.indexOf("*");
    const prefix = star < 0 ? pattern : pattern.slice(0, star);
    if (star < 0 ? spec === pattern : spec.startsWith(prefix)) {
      const rest = star < 0 ? "" : spec.slice(prefix.length);
      return posix.normalize(posix.join(owner ?? ".", target.replace("*", rest)));
    }
  }
  return null;
}

// A file RED will find: on the base, or carried along with the tests. TS sources are often
// imported under their emitted name (`./x.js` for x.ts).
function resolves(target, view, carried) {
  const stem = target.replace(/\.[cm]?js$/, "");
  return [target, stem].some((path) =>
    RESOLVED_SUFFIXES.some((suffix) => view.files.has(path + suffix) || carried.has(path + suffix)),
  );
}

const providers = (name, view) =>
  view.manifests.filter((path) => view.declared(path).has(name)).map((path) => posix.dirname(path));

function judgeSpecifier(rawSpec, file, owner, view, carried) {
  const spec = rawSpec.split("?")[0];
  // A scheme (node:, virtual:, data:), a package-internal #import, or a builtin never comes from
  // the base's dependency lists.
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("#") || BUILTIN.has(spec)) {
    return null;
  }
  if (spec.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(file), spec));
    return resolves(target, view, carried)
      ? null
      : {
          file,
          spec,
          problem: `imports "${spec}", which neither exists on the base nor is carried into the RED proof (only *.test.ts(x) and __fixtures__/ files are)`,
          fix: "import through a module the base already has, or put the helper in a __fixtures__/ directory",
        };
  }
  const alias = aliasTarget(spec, owner, view);
  if (alias !== null) {
    return resolves(alias, view, carried)
      ? null
      : {
          file,
          spec,
          problem: `imports "${spec}" (${alias}), which neither exists on the base nor is carried into the RED proof`,
          fix: "import through a module the base already has, or put the helper in a __fixtures__/ directory",
        };
  }
  const name = packageName(spec);
  const own = owner ? view.manifest(`${owner}/package.json`).name : undefined;
  const available =
    name === own ||
    (owner !== null && view.declared(`${owner}/package.json`).has(name)) ||
    // Node resolution walks up to the root's node_modules.
    view.declared("package.json").has(name);
  if (available) {
    return null;
  }
  const elsewhere = providers(name, view);
  return {
    file,
    spec,
    problem: `imports "${name}", which ${owner ?? "the root package"} does not declare on the base, so this file cannot load in the RED proof`,
    fix: `${
      elsewhere.length > 0
        ? `the base declares it in ${elsewhere.join(", ")}: move the test there or reach it through that package`
        : "no package on the base declares it"
    }. Adding it to package.json in this run does not help, because RED runs on the base. If neither works, leave the import and finish normally: the harness stops with NEEDS PREPARATION, keeps the work, and a human adds the dependency to the base first`,
  };
}

// --- Manifests against the lockfile ----------------------------------------------------------------

/** `importers:` of a pnpm lockfile: package dir -> dependency name -> specifier. */
export function lockedSpecifiers(lockText) {
  const importers = new Map();
  let importer = null;
  let name = null;
  for (const raw of importerLines(lockText)) {
    const line = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (indent === 2 && line.endsWith(":")) {
      importer = new Map();
      importers.set(unquote(line.slice(0, -1)), importer);
    } else if (indent === 6 && line.endsWith(":")) {
      name = unquote(line.slice(0, -1));
    } else if (indent === 8 && line.startsWith("specifier: ")) {
      importer?.set(name, unquote(line.slice("specifier: ".length)));
    }
  }
  return importers;
}

const unquote = (value) => value.replace(/^['"]|['"]$/g, "");

function importerLines(lockText) {
  const lines = lockText.split(/\r?\n/);
  const start = lines.indexOf("importers:");
  if (start < 0) {
    return [];
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

// A manifest change the lockfile does not carry fails `pnpm install --frozen-lockfile`, the first
// thing the host's verifier does.
function lockFindings(changed, readFile, view) {
  const lockText = readFile("pnpm-lock.yaml");
  if (lockText === null) {
    return [];
  }
  const importers = lockedSpecifiers(lockText);
  const findings = [];
  for (const path of changed.filter((p) => posix.basename(p) === "package.json")) {
    const text = readFile(path);
    if (text === null || text === view.read(path)) {
      continue;
    }
    const pkg = JSON.parse(text);
    const dir = posix.dirname(path);
    const wanted = new Map(LOCKED_FIELDS.flatMap((field) => Object.entries(pkg[field] ?? {})));
    const locked = importers.get(dir) ?? new Map();
    const stale = [...wanted].filter(([name, spec]) => locked.get(name) !== spec);
    const orphaned = [...locked.keys()].filter((name) => !wanted.has(name));
    if (stale.length + orphaned.length > 0) {
      findings.push({
        file: path,
        spec: [...stale.map(([name]) => name), ...orphaned].join(", "),
        problem: `disagrees with pnpm-lock.yaml on ${[...stale.map(([name]) => name), ...orphaned].join(", ")}, so the host's frozen install would fail`,
        fix: "update pnpm-lock.yaml together with the manifest (pnpm install), not one of them by hand",
      });
    }
  }
  return findings;
}

// --- The checks ------------------------------------------------------------------------------------

function workingTree(root, base) {
  return {
    changed: [
      ...gitList(root, "diff", "-z", "--name-only", "--diff-filter=d", base),
      ...gitList(root, "ls-files", "-z", "--others", "--exclude-standard"),
    ],
    readFile: (path) => {
      const absolute = join(root, path);
      return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    },
  };
}

function candidateTree(root, base, candidate) {
  return {
    changed: gitList(root, "diff", "-z", "--name-only", "--diff-filter=d", base, candidate),
    readFile: (path) => show(root, candidate, path),
  };
}

/** What stands between these changes and a RED proof on the base. */
export function importFindings({ root, base, tree }) {
  const view = baseView(root, base);
  const carriedFiles = tree.changed.filter((path) => CARRIED.test(path));
  const carried = new Set(carriedFiles);
  const findings = [];
  const seen = new Set();
  const hasWorkspaces = view.files.has("pnpm-workspace.yaml");
  for (const file of carriedFiles.filter((path) => SOURCE.test(path))) {
    const owner = ownerOf(file, view);
    // In a package the base does not have, one finding (below) says all there is to say.
    if (owner === null && hasWorkspaces) {
      continue;
    }
    for (const spec of loadedSpecifiers(tree.readFile(file) ?? "")) {
      const finding = judgeSpecifier(spec, file, owner, view, carried);
      if (finding && !seen.has(`${file}\0${spec}`)) {
        seen.add(`${file}\0${spec}`);
        findings.push(finding);
      }
    }
  }
  // Without a workspace file RED's own planner has nothing to say; RED itself still runs.
  if (hasWorkspaces) {
    const tests = carriedFiles.filter((path) => TEST_FILE.test(path));
    for (const problem of planRun(tests, plannerIo(root, view)).errors) {
      const file = problem.split(" ")[0];
      findings.push({
        file,
        spec: "",
        problem: problem.slice(file.length + 1),
        fix: "a new workspace package needs its own reviewed scaffold on the base first",
      });
    }
  }
  return [...findings, ...lockFindings(tree.changed, tree.readFile, view)];
}

const render = (findings) =>
  findings.map(({ file, problem, fix }) => `- ${file}: ${problem}.\n  Fix: ${fix}.`).join("\n");

function report(findings) {
  if (findings.length === 0) {
    process.stdout.write("READY\n");
    return 0;
  }
  process.stdout.write(`NEEDS PREPARATION\n${render(findings)}\n`);
  return NEEDS_PREPARATION;
}

// Called after each tool use of an Implementer. Findings are repeated only when they change, or
// every later tool call would interrupt the agent with what it already knows. The log is how a run
// shows that the hook fired at all.
function runHook(root) {
  const base = env.RALPH_BASE_SHA;
  if (!base) {
    return 0;
  }
  try {
    const dir = join(root, ".ralph/lead");
    mkdirSync(dir, { recursive: true });
    const findings = importFindings({ root, base, tree: workingTree(root, base) });
    appendFileSync(
      join(dir, "preflight-hook.log"),
      `${new Date().toISOString()} ${findings.length}\n`,
    );
    const text = render(findings);
    const digest = createHash("sha256").update(text).digest("hex");
    const seenPath = join(dir, "preflight-hook.seen");
    const seen = existsSync(seenPath) ? readFileSync(seenPath, "utf8") : "";
    writeFileSync(seenPath, digest);
    if (findings.length === 0 || digest === seen) {
      return 0;
    }
    process.stderr.write(
      `Preflight: these test files will fail the RED proof on the base (${base.slice(0, 12)}):\n${text}\n`,
    );
    return HOOK_FEEDBACK;
  } catch (error) {
    process.stdout.write(`preflight hook could not run: ${error.message}\n`);
    return 0;
  }
}

const CRITERION = /^\s*- \[ \]\s*(.*)$/gm;
const NAMES_DOCS = /[\w./-]+\.md\b|\bdocs\/|\bREADME\b|\bdocument(?:s|ed|ation)?\b/i;
const NAMES_PROOF = /\btests?\b|\bsabotage\b|\bassert|\bprove[sd]?\b|\bRESOLVED\b/i;

/** Criteria no test can verify, and workspace packages the ticket needs that the base lacks. */
export function ticketFindings(text, view, file) {
  const docs = [...text.matchAll(CRITERION)]
    .map(([, criterion]) => criterion)
    .filter((criterion) => NAMES_DOCS.test(criterion) && !NAMES_PROOF.test(criterion))
    .map((criterion) => ({
      file,
      spec: "",
      problem: `this criterion describes documentation and names no test, so the host review will block it as unverifiable: "${criterion.slice(0, 100)}"`,
      fix: "move it to a **Documentation deliverable (reviewed, not test-verified):** paragraph (issues/README.md)",
    }));
  const packages = [...missingPackages(text, view)].map((dir) => ({
    file,
    spec: "",
    problem: `names ${dir}, a workspace package the base does not have, so its tests cannot run in the RED proof`,
    fix: "add the package's scaffold in its own reviewed ticket first",
  }));
  return [...docs, ...packages];
}

function missingPackages(text, view) {
  const prefixes = workspaceGlobs(view.read("pnpm-workspace.yaml") ?? "")
    .filter((glob) => glob.endsWith("/*"))
    .map((glob) => glob.slice(0, -1));
  const missing = new Set();
  for (const [, token] of text.matchAll(/`([^`\s*<]+)`/g)) {
    for (const prefix of prefixes) {
      const name = token.startsWith(prefix) ? token.slice(prefix.length).split("/")[0] : "";
      if (name !== "" && !view.files.has(`${prefix}${name}/package.json`)) {
        missing.add(`${prefix}${name}`);
      }
    }
  }
  return missing;
}

/**
 * Identifies the code of a commit, leaving out paths that only record the project's bookkeeping,
 * so a verification stays valid when only those moved on (a ticket's status, a debt entry).
 */
export function baselineKey({ root, commit, exclude }) {
  const entries = git(root, "ls-tree", "-r", commit)
    .split("\n")
    .filter((line) => {
      const path = line.split("\t")[1] ?? "";
      return (
        path !== "" && !exclude.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e))
      );
    });
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      base: { type: "string" },
      candidate: { type: "string" },
      commit: { type: "string" },
      exclude: { type: "string", multiple: true, default: [] },
      hook: { type: "boolean", default: false },
    },
  });
  const root = resolve(values.root);
  const [command, argument] = positionals;
  if (command === "imports" && values.hook) {
    return runHook(root);
  }
  if (command === "imports" && values.base) {
    const tree = values.candidate
      ? candidateTree(root, values.base, values.candidate)
      : workingTree(root, values.base);
    return report(importFindings({ root, base: values.base, tree }));
  }
  if (command === "ticket" && argument && values.base) {
    const text = readFileSync(resolve(root, argument), "utf8");
    return report(ticketFindings(text, baseView(root, values.base), argument));
  }
  if (command === "baseline-key" && values.commit) {
    process.stdout.write(
      `${baselineKey({ root, commit: values.commit, exclude: values.exclude })}\n`,
    );
    return 0;
  }
  process.stderr.write(
    "usage: ralph-preflight.mjs imports --base <sha> [--candidate <sha>] | imports --hook | ticket <file> --base <sha> | baseline-key --commit <rev>\n",
  );
  return CANNOT_RUN;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`preflight could not run: ${error.message}\n`);
    process.exitCode = CANNOT_RUN;
  }
}
