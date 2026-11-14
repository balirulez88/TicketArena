// Agent Activity and Run History views. A pipeline stage lights up only on recorded evidence;
// every stage carries the note that explains its state (the session, or why there is none).

import {
  ago,
  badge,
  card,
  dot,
  empty,
  liveness,
  provenance,
  STAGE_TONE,
  sessionStatus,
  verdict,
  when,
} from "./components";
import { domKey, h } from "./html";
import type { Session } from "./model";
import {
  executionStatus,
  formatDuration,
  PHASE_STAGE,
  type PipelineView,
  pipelinesOf,
  type RunSummary,
  reviewsUncertain,
  STAGE_TITLE,
  summarizeRun,
} from "./present";
import type { DashboardState, RunView } from "./state";

const STAGE_STATE_LABEL = {
  active: "active",
  completed: "completed",
  failed: "failed",
  stale: "stale",
  unknown: "no evidence",
} as const;

export function pipeline(view: PipelineView) {
  return h`<div class="pipeline-wrap">
    <div class="pipeline-head"><span class="mono strong">#${view.ticket}</span><span class="muted mono">${view.runId}</span></div>
    <ol class="pipeline">${view.stages.map(
      (stage) => h`<li class="stage s-${stage.state}" title="${stage.note}">
        <span class="stage-node t-${STAGE_TONE[stage.state]}" aria-hidden="true"></span>
        <span class="stage-name">${STAGE_TITLE[stage.stage]}</span>
        <span class="stage-state">${STAGE_STATE_LABEL[stage.state]}${stage.sessions.length > 0 ? ` · ${stage.sessions.length}` : ""}</span>
        <span class="stage-note">${stage.note}</span>
      </li>`,
    )}</ol>
    ${view.unmapped.length > 0 ? h`<p class="muted small">Not mapped to a stage: ${view.unmapped.map((s) => h`<code>${s.label}</code> ${sessionStatus(s.status)} `)}${view.unmapped.some((s) => s.phase === "lead") ? " (a Lead session covers every stage at once)" : ""}</p>` : ""}
  </div>`;
}

const sessionMs = (session: Session): number | null => {
  const start = Date.parse(session.started);
  const end = session.finished === null ? Number.NaN : Date.parse(session.finished);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
};

const sessionsUnavailable = (run: RunView) =>
  run.sessionsIncomplete === null
    ? ""
    : h`<p class="small">${provenance("unavailable")} <span class="muted">Some session records could not be read: ${run.sessionsIncomplete}</span></p>`;

export function sessionTimeline(run: RunView) {
  if (run.sessions.length === 0) {
    return run.sessionsIncomplete === null
      ? h`<p class="muted small">No session records in this run.</p>`
      : sessionsUnavailable(run);
  }
  return h`${sessionsUnavailable(run)}<ol class="timeline">${run.sessions.map(
    (session) => h`<li class="tl-item">
      ${dot(session.status === "ok" ? "ok" : session.status === "running" ? "live" : "bad")}
      <span class="mono small muted">${when(session.started)}</span>
      <code>${session.label}</code>
      <span class="muted small">${PHASE_STAGE[session.phase] ?? "no stage"}</span>
      ${sessionStatus(session.status)}
      <span class="muted small">${session.status === "running" ? "" : formatDuration(sessionMs(session))}</span>
    </li>`,
  )}</ol>`;
}

function liveRunCard(run: RunView, state: DashboardState, now: number) {
  const pipelines = pipelinesOf(run, state);
  return h`<section class="card run-card ${run.liveness}">
    <header class="card-head"><h3><span class="mono">${run.runId}</span></h3>${liveness(run.liveness)}</header>
    <div class="meta-row">
      <span>Current session: ${run.current ? h`<code>${run.current.label}</code> ${sessionStatus(run.current.status)}` : h`<span class="muted">none recorded as running</span>`}</span>
      <span class="muted">Last file activity ${ago(run.lastActivity, now)}</span>
      <span class="muted">${run.origin}</span>
    </div>
    ${run.liveness === "stale" ? h`<p class="note warn">run.json still says <code>active</code>, but nothing changed for over ${state.staleAfterMinutes} min. A killed run stays <code>active</code> forever; process liveness is not checked.</p>` : ""}
    ${pipelines.length === 0 ? (run.sessionsIncomplete === null ? h`<p class="muted small">No ticket session recorded yet.</p>` : sessionsUnavailable(run)) : pipelines.map(pipeline)}
    <details class="disclosure" data-key="${`agents-tl-${domKey(run.runId)}`}"><summary>Session timeline (${run.sessions.length})</summary>${sessionTimeline(run)}</details>
  </section>`;
}

export function agentsView(state: DashboardState, now: number) {
  const execution = executionStatus(state);
  const recent = state.runs.filter((run) => !execution.runs.includes(run)).slice(0, 6);
  const current =
    execution.kind === "idle"
      ? h`<section class="card">${empty(
          "No run is active",
          h`No <code>run.json</code> claims <code>active</code>. The pipelines below are finished records.`,
        )}</section>`
      : execution.kind === "unknown"
        ? h`<section class="card">${empty(
            "Run state unknown",
            `Run artifacts could not be fully read, so a run may be active: ${execution.reason ?? ""}`,
            "bad",
          )}</section>${execution.runs.map((run) => liveRunCard(run, state, now))}`
        : execution.runs.map((run) => liveRunCard(run, state, now));
  const nowTag = {
    idle: "historical",
    unknown: "unavailable",
    live: "live",
    stale: "live",
  } as const;
  return h`<div class="view-head"><div><h2>Agent Activity</h2>
      <p class="muted">Stages come from session labels in run logs: <code>red</code> → Testing; <code>green</code>, <code>refactor</code>, <code>docs</code> → Implementation; <code>review-*</code> → Review; a completion record naming the run → Merge. Ralph records no planning step.</p></div></div>
    <div class="legend">${(["active", "completed", "failed", "stale", "unknown"] as const).map((s) => h`<span>${dot(STAGE_TONE[s])} ${STAGE_STATE_LABEL[s]}</span>`)}</div>
    <h3 class="section-title">Now ${provenance(nowTag[execution.kind])}</h3>
    <div class="stack">${current}</div>
    <h3 class="section-title">Recent runs ${provenance("historical")}${state.runsIncomplete === null ? "" : h` ${provenance("unavailable")}`}</h3>
    <div class="stack">${
      recent.length === 0
        ? state.runsIncomplete === null
          ? h`<p class="muted">No other runs in <code>.ralph/logs</code> or sandboxes.</p>`
          : h`<p class="muted">Run logs unavailable: ${state.runsIncomplete}</p>`
        : recent.map(
            (
              run,
            ) => h`<details class="card disclosure run-collapse" data-key="${`agents-${domKey(run.runId)}`}">
              <summary><span class="mono">${run.runId}</span> ${liveness(run.liveness)} <span class="muted">${run.tickets.map((t) => `#${t}`).join(" ") || (run.sessionsIncomplete === null ? "no ticket sessions" : "tickets unknown")}</span></summary>
              ${pipelinesOf(run, state).map(pipeline)}
              <h4>Session timeline</h4>${sessionTimeline(run)}
            </details>`,
          )
    }</div>`;
}

const OUTCOME_TONE: Record<string, "ok" | "bad" | "warn" | "live" | "muted"> = {
  succeeded: "ok",
  failed: "bad",
  paused: "warn",
  running: "live",
  stale: "warn",
};

function runItem(summary: RunSummary, state: DashboardState) {
  const { run } = summary;
  const tone = OUTCOME_TONE[summary.outcome] ?? "muted";
  const approved = summary.reviews.filter((r) => r.decision.verdict === "approved").length;
  const rejected = summary.reviews.length - approved;
  const reviewsMissing = reviewsUncertain(state, { kind: "loop", run: run.runId });
  const reviewCounts =
    summary.reviews.length > 0
      ? h`<span class="small">${approved > 0 ? badge(`${approved} approved`, "ok") : ""} ${rejected > 0 ? badge(`${rejected} rejected`, "bad") : ""}</span>`
      : reviewsMissing === null
        ? h`<span class="muted small">no reviews</span>`
        : "";
  const sessions =
    run.sessionsIncomplete === null
      ? h`<span class="muted small">${run.sessions.length} sessions</span>`
      : badge("session records unavailable", "bad", run.sessionsIncomplete);
  return h`<li class="history-item">
    <span class="history-dot t-${tone}" aria-hidden="true"></span>
    <details class="card disclosure" data-key="${`run-${domKey(run.runId)}`}">
      <summary class="history-summary">
        <span class="mono strong">${run.runId}</span>
        ${badge(summary.outcome, tone, "run.json status, qualified by liveness")}
        <span class="muted">${formatDuration(summary.durationMs)}</span>
        <span class="chips">${run.tickets.map((t) => h`<span class="chip mono">#${t}</span>`)}</span>
        <span class="spacer"></span>
        ${reviewCounts}${reviewsMissing === null ? "" : badge("reviews unavailable", "bad", reviewsMissing)}
        ${sessions}
      </summary>
      <div class="history-body">
        <dl class="kv">
          <dt>Started</dt><dd>${when(run.startedAt)}</dd>
          <dt>Finished</dt><dd>${run.finishedAt ? when(run.finishedAt) : h`<span class="muted">not recorded</span>`}</dd>
          <dt>Origin</dt><dd>${run.origin}</dd>
          <dt>run.json</dt><dd>${run.status === null ? provenance("unavailable") : h`<code>${run.status}</code>`}</dd>
        </dl>
        ${summary.rejections.length > 0 ? h`<h4>Rejection reasons</h4><ul class="reasons">${summary.rejections.map((r) => h`<li>${r}</li>`)}</ul>` : ""}
        ${summary.failures.length > 0 ? h`<h4>Failures</h4><ul class="reasons">${summary.failures.map((f) => h`<li>${badge(f.kind, "bad")} ${f.detail}</li>`)}</ul>` : ""}
        ${
          summary.reviews.length > 0
            ? h`<h4>Reviews</h4><ul class="plain">${summary.reviews.map(
                (r) =>
                  h`<li>${verdict(r.decision.verdict)} <span class="muted">${r.kind}${r.round === null ? "" : ` round ${r.round}`}</span> ${r.slug} ${Object.entries(
                    r.decision.findings,
                  )
                    .map(([severity, count]) => `${count} ${severity}`)
                    .join(
                      ", ",
                    )}${r.decision.errors > 0 ? ` · ${r.decision.errors} evidence errors` : ""}</li>`,
              )}</ul>`
            : ""
        }
        <h4>Session timeline</h4>${sessionTimeline(run)}
      </div>
    </details>
  </li>`;
}

export function runsView(state: DashboardState, now: number) {
  const summaries = state.runs.map((run) => summarizeRun(run, state, now));
  const counts = { succeeded: 0, failed: 0, other: 0 };
  for (const s of summaries) {
    if (s.outcome === "succeeded") {
      counts.succeeded += 1;
    } else if (s.outcome === "failed") {
      counts.failed += 1;
    } else {
      counts.other += 1;
    }
  }
  const reviewsWithoutRun = state.reviews.filter(
    (review) => !state.runs.some((run) => run.runId === review.run),
  );
  // Counts over an incomplete list would read as totals; show what was read and say why it is not
  // everything instead.
  const incomplete = state.runsIncomplete;
  const chips =
    incomplete === null
      ? h`${badge(`${counts.succeeded} succeeded`, "ok")} ${badge(`${counts.failed} failed`, "bad")} ${badge(`${counts.other} other`, "muted")}`
      : h`${provenance("unavailable")} <span class="muted small">${summaries.length} runs read; the list is incomplete</span>`;
  const list =
    summaries.length > 0
      ? h`<ol class="history">${summaries.map((s) => runItem(s, state))}</ol>`
      : incomplete === null
        ? card("No runs", empty("Nothing on record", "No run directories were found."))
        : card(h`Run history ${provenance("unavailable")}`, h`<p class="muted">${incomplete}</p>`);
  return h`<div class="view-head"><div><h2>Run History</h2>
    <p class="muted">Runs in <code>.ralph/logs</code> and live sandboxes, newest first. Logs are kept 30 days.</p></div>
    <div class="chips">${chips}</div></div>
    ${incomplete !== null && summaries.length > 0 ? h`<p class="muted small">Run list incomplete: ${incomplete}</p>` : ""}
    ${list}
    ${
      reviewsWithoutRun.length > 0
        ? h`<details class="card disclosure" data-key="host-reviews"><summary>Host reviews of sandbox runs (${reviewsWithoutRun.length})</summary>
        <ul class="plain">${reviewsWithoutRun.map((r) => h`<li>${verdict(r.decision.verdict)} <span class="mono">${r.run}</span> ${r.slug} ${r.decision.blockers.map((b) => h`<div class="small muted">[${b.severity}] ${b.axis}: ${b.title}</div>`)}</li>`)}</ul></details>`
        : ""
    }`;
}
