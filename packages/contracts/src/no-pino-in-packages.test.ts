import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packagesDir = join(import.meta.dirname, "../..");
const PINO_IMPORT = /from\s+["']pino["']|require\(["']pino["']\)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("logger injection", () => {
  it("no package imports pino or depends on it: apps create the logger", () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      const root = join(packagesDir, pkg);
      if (!statSync(root).isDirectory()) {
        continue;
      }
      if (readFileSync(join(root, "package.json"), "utf8").includes('"pino"')) {
        offenders.push(pkg);
      }
      offenders.push(
        ...sourceFiles(join(root, "src")).filter((file) =>
          PINO_IMPORT.test(readFileSync(file, "utf8")),
        ),
      );
    }
    expect(offenders).toEqual([]);
  });
});
