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

describe("logging docs", () => {
  it("docs/architecture describes logger injection, id bindings and causation", () => {
    const doc = readFileSync(join(docsDir, "architecture", "index.md"), "utf8");
    for (const term of ["Logger injection", "correlationId", "causationId", "causedBy", "emit"]) {
      expect(doc).toContain(term);
    }
  });
});

describe("provider latency docs", () => {
  it("docs/messaging places the payment provider latency in beforeTransaction, outside the transaction and before dedupe-and-capture (TD-051)", () => {
    const doc = readFileSync(join(docsDir, "messaging", "index.md"), "utf8");
    expect(doc).toContain("`beforeTransaction`");
    expect(doc).toContain("outside the transaction");
    expect(doc).toContain("before dedupe-and-capture");
    expect(doc).toContain("interactive-transaction timeout");
  });
});
