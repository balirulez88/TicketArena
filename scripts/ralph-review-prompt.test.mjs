import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewPrompt } from "./ralph-review-prompt.mjs";

const input = (axis, ticketText) => ({
  axis,
  ticket: "issues/done/99-demo.md",
  ticketText,
  changeset: ".ralph/review/host/changeset.diff",
  base: "a".repeat(40),
  head: "b".repeat(40),
  range: "a...b",
  changedFiles: ["x.ts"],
  commits: ["feat: x"],
  register: "docs/technical-debt.md",
});
const WITH =
  "# 99: Demo\n\n- [ ] works\n\n**Documentation deliverable (reviewed, not test-verified):** docs say so.\n";
const WITHOUT = "# 99: Demo\n\n- [ ] works\n";

describe("reviewPrompt", () => {
  it("makes a missing documentation deliverable a HIGH Spec finding", () => {
    const prompt = reviewPrompt(input("spec", WITH));
    assert.match(prompt, /Documentation deliverable paragraph/);
    assert.match(prompt, /HIGH finding on the Spec axis/);
  });

  it("says nothing about it when the ticket has none, or on the Standards axis", () => {
    assert.doesNotMatch(reviewPrompt(input("spec", WITHOUT)), /Documentation deliverable/);
    assert.doesNotMatch(reviewPrompt(input("standards", WITH)), /Documentation deliverable/);
  });

  it("does not turn the paragraph into a criterion", () => {
    const prompt = reviewPrompt(input("spec", WITH));
    assert.match(prompt, /AC1: works/);
    assert.doesNotMatch(prompt, /AC2:/);
  });
});
