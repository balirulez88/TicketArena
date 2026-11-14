// The browser script is written in TypeScript (type-checked and tested with the rest) and served
// as JavaScript. It has no runtime imports, so a type-only transpile is all it needs: no bundler,
// no new dependency. The TypeScript compiler is already how this app runs (through tsx).

import { readFileSync } from "node:fs";
import ts from "typescript";

const CLIENT_SOURCE = new URL("./client/dashboard.ts", import.meta.url);

let compiled: string | undefined;

/** The dashboard's client script as an ES module, compiled once per process. */
export function clientScript(): string {
  compiled ??= ts.transpileModule(readFileSync(CLIENT_SOURCE, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: false,
  }).outputText;
  return compiled;
}
