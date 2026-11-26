import { describe, expect, it } from "vitest";
import { type CiRun, type DeployFacts, decideDeployTarget } from "./deploy-target.js";

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);

function ci(overrides: Partial<CiRun> = {}): CiRun {
  return {
    headSha: TIP,
    event: "push",
    headBranch: "main",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-11-24T10:00:00Z",
    ...overrides,
  };
}

function facts(overrides: Partial<DeployFacts> = {}): DeployFacts {
  return {
    event: "workflow_run",
    candidateSha: TIP,
    mainSha: TIP,
    ciRuns: [ci()],
    ...overrides,
  };
}

describe("decideDeployTarget", () => {
  it.each(["workflow_run", "workflow_dispatch"] as const)(
    "%s: deploys the tip of main once CI passed on its push",
    (event) => {
      expect(decideDeployTarget(facts({ event }))).toEqual({ action: "deploy", sha: TIP });
    },
  );

  it("a re-run of an old successful CI run is skipped, never deployed onto the newer schema", () => {
    const replayed = facts({ candidateSha: OLDER, ciRuns: [ci({ headSha: OLDER })] });

    expect(decideDeployTarget(replayed)).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("is not the tip of main"),
    });
  });

  it("a manual run fails when main moved after it started", () => {
    const moved = facts({ event: "workflow_dispatch", candidateSha: OLDER });

    expect(decideDeployTarget(moved)).toMatchObject({ action: "fail" });
  });

  it("a re-run job fails when a later deployment moved main past the commit its gate pinned", () => {
    // Run A's gate pinned OLDER and its web job failed; run B then shipped TIP. "Re-run failed
    // jobs" on A keeps A's gate output, so the web job re-checks OLDER against main's tip now.
    const rerun = facts({
      event: "recheck",
      candidateSha: OLDER,
      ciRuns: [ci({ headSha: OLDER })],
    });

    expect(decideDeployTarget(rerun)).toMatchObject({
      action: "fail",
      reason: expect.stringContaining("a re-run job never ships it"),
    });
  });

  it("a job re-check passes while the pinned commit is still the tip of main", () => {
    expect(decideDeployTarget(facts({ event: "recheck" }))).toEqual({ action: "deploy", sha: TIP });
  });

  it.each([
    ["pending", ci({ status: "in_progress", conclusion: null }), /still in_progress/],
    ["failed", ci({ conclusion: "failure" }), /ended failure/],
    ["cancelled", ci({ conclusion: "cancelled" }), /ended cancelled/],
  ])("a manual run with %s CI fails instead of deploying", (_, run, reason) => {
    const decision = decideDeployTarget(facts({ event: "workflow_dispatch", ciRuns: [run] }));

    expect(decision).toMatchObject({ action: "fail", reason: expect.stringMatching(reason) });
  });

  it("a manual run with no CI run of a push to main fails", () => {
    expect(decideDeployTarget(facts({ event: "workflow_dispatch", ciRuns: [] }))).toMatchObject({
      action: "fail",
      reason: expect.stringContaining("no CI run"),
    });
  });

  it("CI that passed for another commit, a pull request or another branch does not count", () => {
    const elsewhere = [
      ci({ headSha: OLDER }),
      ci({ event: "pull_request" }),
      ci({ headBranch: "feature" }),
    ];

    expect(
      decideDeployTarget(facts({ event: "workflow_dispatch", ciRuns: elsewhere })),
    ).toMatchObject({ action: "fail", reason: expect.stringContaining("no CI run") });
  });

  it("the latest CI run of the commit decides: a failed re-run after a pass blocks", () => {
    const runs = [
      ci({ createdAt: "2026-11-24T10:00:00Z" }),
      ci({ createdAt: "2026-11-24T11:00:00Z", conclusion: "failure" }),
    ];

    expect(decideDeployTarget(facts({ event: "workflow_dispatch", ciRuns: runs }))).toMatchObject({
      action: "fail",
    });
  });
});
