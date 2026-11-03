import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = join(import.meta.dirname, "../../../docs");

describe("worker docs", () => {
  for (const area of ["messaging", "architecture"]) {
    it(`docs/${area} names the worker, the relay, its 250 ms interval, batch of 100 and the consumer runner`, () => {
      const doc = readFileSync(join(docsDir, area, "index.md"), "utf8").toLowerCase();
      expect(doc).toContain("worker");
      expect(doc).toContain("relay");
      expect(doc).toContain("250 ms");
      expect(doc).toContain("batch of 100");
      expect(doc).toContain("consumer runner");
    });
  }
});
