import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// CLAUDE.md: packages never read the environment; apps validate it at their boundary and inject
// it (TD-001). This holds the rule over every package's source, not only this one's.
const PACKAGES = resolve(__dirname, "../..");
// test-infra is test-only code: its `loadTestEnv` is the test suite's environment boundary.
const TEST_ONLY_PACKAGES = new Set(["test-infra"]);
// Prisma's generated client (git-ignored) is not our code.
const GENERATED = "generated";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === GENERATED ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function isProcess(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "process" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis")
  );
}

/** Every `process.env`, `process["env"]` and `const { env } = process` in the file, by line. */
function envReads(file: string): number[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const lines: number[] = [];
  const record = (node: ts.Node) =>
    lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "env" &&
        isProcess(node.expression)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "env" &&
        isProcess(node.expression)) ||
      (ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        isProcess(node.initializer))
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function envReadsUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !TEST_ONLY_PACKAGES.has(entry.name))
    .flatMap((entry) => {
      const src = join(root, entry.name, "src");
      try {
        return sourceFiles(src);
      } catch {
        // A package without a src directory has no source to check.
        return [];
      }
    })
    .flatMap((file) =>
      envReads(file).map((line) => `${relative(root, file).replaceAll("\\", "/")}:${line}`),
    );
}

describe("packages read no environment", () => {
  it("no file under packages/*/src outside tests reads process.env", () => {
    expect(envReadsUnder(PACKAGES)).toEqual([]);
  });
});
