import { appendFileSync } from "node:fs";

/**
 * Decides which commit a production deployment may ship (ADR 0013): only the current tip of
 * `main`, and only once CI passed on a push of that exact commit. Migrations never roll back, so
 * shipping an older commit, for example from a re-run of an old CI run, would put old code on a
 * newer schema; a manual run must not skip the quality gate either. An intentional rollback is a
 * revert pushed to `main`, which goes through CI like any change (docs/operations/deployment.md).
 *
 * This file runs in the Deploy workflow with plain `node` (type stripping, no install), so it
 * imports only Node built-ins.
 */

/**
 * What asks for the decision: the gate of a run started by a CI run or by hand, or a production
 * job re-checking, right before it acts, the commit its gate pinned. A partial re-run of a job
 * ("Re-run failed jobs") keeps the old gate's outputs, so only that fresh re-check stops it from
 * shipping a commit a later deployment has already moved past.
 */
export type DeployEvent = "workflow_run" | "workflow_dispatch" | "recheck";

/** One run of the CI workflow, as the GitHub Actions API reports it. */
export interface CiRun {
  readonly headSha: string;
  readonly event: string;
  readonly headBranch: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
}

export interface DeployFacts {
  readonly event: DeployEvent;
  /** The commit this run was asked to deploy: the CI run's head for `workflow_run`. */
  readonly candidateSha: string;
  /** The tip of `main` now, read under the deployment concurrency group. */
  readonly mainSha: string;
  /** CI runs reported for `candidateSha`, in any order. */
  readonly ciRuns: readonly CiRun[];
}

export type DeployDecision =
  | { readonly action: "deploy"; readonly sha: string }
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "fail"; readonly reason: string };

export function decideDeployTarget(facts: DeployFacts): DeployDecision {
  const { event, candidateSha, mainSha } = facts;
  if (candidateSha !== mainSha) {
    const reason = `${candidateSha} is not the tip of main (${mainSha})`;
    // A newer push has its own CI run and deployment; an old one replayed must never ship.
    if (event === "workflow_run") {
      return { action: "skip", reason: `${reason}: a stale or replayed CI run is never deployed` };
    }
    // A job must fail rather than skip: a skipped migrate job would let web and worker run.
    return event === "recheck"
      ? {
          action: "fail",
          reason: `${reason}: the gate pinned an older commit; a re-run job never ships it`,
        }
      : { action: "fail", reason: `${reason}: main moved after this run started; run it again` };
  }

  const pushes = facts.ciRuns
    .filter((run) => run.headSha === candidateSha && run.event === "push")
    .filter((run) => run.headBranch === "main")
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = pushes[0];
  if (latest === undefined) {
    return { action: "fail", reason: `no CI run of a push to main exists for ${candidateSha}` };
  }
  if (latest.status !== "completed") {
    return {
      action: "fail",
      reason: `CI for ${candidateSha} is still ${latest.status}; deploy once it has passed`,
    };
  }
  if (latest.conclusion !== "success") {
    return {
      action: "fail",
      reason: `CI for ${candidateSha} ended ${latest.conclusion ?? "without a conclusion"}`,
    };
  }
  return { action: "deploy", sha: candidateSha };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`deploy-target: ${name} must be set`);
  }
  return value;
}

function deployEvent(value: string): DeployEvent {
  if (value !== "workflow_run" && value !== "workflow_dispatch" && value !== "recheck") {
    throw new Error(`deploy-target: EVENT_NAME must be workflow_run, workflow_dispatch or recheck`);
  }
  return value;
}

interface ApiRun {
  readonly head_sha: string;
  readonly event: string;
  readonly head_branch: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
}

async function github<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`deploy-target: GET ${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Reads the facts from the GitHub API, decides, and writes `sha` or fails the step. */
async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const repo = required(env, "GITHUB_REPOSITORY");
  const token = required(env, "GITHUB_TOKEN");
  const candidateSha = required(env, "CANDIDATE_SHA");
  const event = deployEvent(required(env, "EVENT_NAME"));
  const output = required(env, "GITHUB_OUTPUT");

  const ref = await github<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/main`, token);
  const runs = await github<{ workflow_runs: ApiRun[] }>(
    `/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${candidateSha}&per_page=100`,
    token,
  );
  const decision = decideDeployTarget({
    event,
    candidateSha,
    mainSha: ref.object.sha,
    ciRuns: runs.workflow_runs.map((run) => ({
      headSha: run.head_sha,
      event: run.event,
      headBranch: run.head_branch ?? "",
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
    })),
  });

  if (decision.action === "deploy") {
    process.stdout.write(`deploying ${decision.sha}\n`);
    appendFileSync(output, `deploy=true\nsha=${decision.sha}\n`);
  } else if (decision.action === "skip") {
    process.stdout.write(`::notice::not deploying: ${decision.reason}\n`);
    appendFileSync(output, "deploy=false\n");
  } else {
    process.stdout.write(`::error::not deploying: ${decision.reason}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main(process.env);
}
