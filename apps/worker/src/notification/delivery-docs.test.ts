import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const messagingDoc = readFileSync(
  fileURLToPath(new URL("../../../../docs/messaging/index.md", import.meta.url)),
  "utf8",
);

describe("notification delivery documentation", () => {
  it("documents external delivery as at-least-once", () => {
    expect(messagingDoc).toContain("**External delivery is at-least-once**");
  });
});
