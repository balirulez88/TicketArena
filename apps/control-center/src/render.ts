// Server-rendered dashboard. All markup and every value is produced here and escaped (see html.ts);
// the client script only switches views, filters, opens details and swaps in a fresh copy of the
// regions marked `data-region`. Without JavaScript every view is shown, one after another.

import {
  ago,
  type BadgeTone,
  badge,
  card,
  dot,
  eligibilityBadge,
  empty,
  icon,
  liveness,
  provenance,
  STATUS_TONE,
  sessionStatus,
  ticketStatus,
  verdict,
  when,
} from "./components";
import { domKey, type Html, h, raw } from "./html";
import {
  boardColumns,
  DEBT_STATUSES,
  debtCounts,
  ELIGIBILITY_LABEL,
  type Eligibility,
  eligibilityOf,
  executionStatus,
  formatDuration,
  pipelinesOf,
  prioritizedDebt,
  recentActivity,
  severityDistribution,
  summarizeRun,
  ticketCounts,
} from "./present";
import { agentsView, pipeline, runsView } from "./render-runs";
import type { DashboardState, TicketView } from "./state";
import { STYLE } from "./style";

export { escapeHtml } from "./html";

const ticketKey = (number: string) => `ticket-${domKey(number)}`;
const debtKey = (id: string) => `debt-${domKey(id)}`;

/** A link that opens a detail in the drawer (client) or jumps to its anchor (no script). */
const detailLink = (key: string, content: Html | string, cls = "link") =>
  h`<a class="${cls}" href="#d-${key}" data-detail="${key}">${content}</a>`;

const ticketLink = (number: string) => detailLink(ticketKey(number), `#${number}`, "chip mono");

const OUTCOME_TONE: Record<string, BadgeTone> = {
  succeeded: "ok",
  running: "live",
  failed: "bad",
  paused: "warn",
  stale: "warn",
};

const EXECUTION_TONE = { live: "live", stale: "warn", idle: "muted" } as const;
const EXECUTION_LABEL = { live: "Run active", stale: "Run stale", idle: "Idle" } as const;

// ---------------------------------------------------------------------------------------------
// Overview

function kpi(
  label: string,
  value: number | string,
  tone: BadgeTone,
  sub: Html | string,
  href: string,
) {
  return h`<a class="kpi" href="${href}"><span class="kpi-label">${dot(tone)}${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub}</span></a>`;
}

const calc = raw('<span class="calc-mark">calc</span>');

function kpis(state: DashboardState) {
  if (state.tickets === null) {
    return card(
      h`Tickets ${provenance("unavailable")}`,
      h`<p>Ticket files could not be read; see Unavailable sources.</p>`,
    );
  }
  const c = ticketCounts(state.tickets);
  const held = state.debt?.held.length;
  const others = c.eligibilityUnknown + c.unrecognized + c.readyForHuman;
  return h`<div class="kpis">
    ${kpi("Eligible now", c.eligible, "ok", h`${calc}selectable by Ralph`, "#board")}
    ${kpi("Waiting", c.waiting, "warn", h`${calc}ready, held by blockers or debt`, "#board")}
    ${kpi("In progress", c.inProgress, "live", "status line", "#board")}
    ${kpi("Blocked", c.blocked, "bad", "status line", "#board")}
    ${kpi("Completed", c.done, "info", "status done", "#board")}
    ${kpi("Debt-held", held ?? "?", held ? "warn" : "muted", h`${calc}debt gate verdicts`, "#debt")}
  </div>
  ${others > 0 ? h`<p class="muted small">Also: ${c.readyForHuman} ready-for-human · ${c.unrecognized} unrecognized status · ${c.eligibilityUnknown} with eligibility unknown.</p>` : ""}`;
}

function executionCard(state: DashboardState, now: number) {
  const execution = executionStatus(state);
  const { batch, lock, pauses, pausedBranches } = state.current;
  const headline = {
    live: { title: "Ralph is running", text: "A run is active and wrote files recently." },
    stale: {
      title: "A run claims to be active, but is quiet",
      text: `No file changed for over ${state.staleAfterMinutes} min. It may have been killed; process liveness is not checked.`,
    },
    idle: { title: "No run is active", text: "No run.json claims active." },
  }[execution.kind];
  return h`<section class="card hero hero-${execution.kind}">
    <div class="hero-main">
      <span class="pulse t-${EXECUTION_TONE[execution.kind]}" aria-hidden="true"></span>
      <div><div class="hero-title">${headline.title}</div><div class="muted">${headline.text}</div></div>
    </div>
    ${execution.runs.map(
      (run) =>
        h`<div class="hero-run"><span class="mono">${run.runId}</span> ${liveness(run.liveness)} ${run.current ? h`<code>${run.current.label}</code> ${sessionStatus(run.current.status)}` : ""} <span class="muted small">files changed ${ago(run.lastActivity, now)}</span></div>`,
    )}
    <dl class="kv compact">
      <dt>Batch lock</dt><dd>${lock.held ? h`${badge("held", "live")} pid ${lock.owner?.pid ?? "unknown"} on ${lock.owner?.host ?? "unknown host"} <span class="muted small">(holder not verified)</span>` : h`<span class="muted">not held</span>`}</dd>
      <dt>Last batch</dt><dd>${batch.value ? h`${provenance(batch.provenance)} <code>${batch.value.batch}</code> <code>${batch.value.status}</code>${batch.value.stop ? h` · stopped <code>${batch.value.stop.reason}</code>` : ""}` : provenance("unavailable")}</dd>
      <dt>Paused</dt><dd>${pauses.length === 0 ? h`<span class="muted">none</span>` : pauses.map((p) => h`<div>${ticketLink(p.ticket)} ${p.reason} in ${p.phase} <span class="muted small">run ${p.run}</span></div>`)}</dd>
      <dt>Parked branches</dt><dd>${pausedBranches.length === 0 ? h`<span class="muted">none</span>` : pausedBranches.map((b) => h`<div><code>${b.name}</code></div>`)}</dd>
    </dl>
  </section>`;
}

function latestRunCard(state: DashboardState, now: number) {
  const run = state.runs[0];
  if (run === undefined) {
    return card("Latest run", empty("No runs on record", "Nothing in .ralph/logs or sandboxes."));
  }
  const summary = summarizeRun(run, state, now);
  return card(
    h`Latest run <span class="mono muted">${run.runId}</span>`,
    h`<div class="meta-row">${badge(summary.outcome, OUTCOME_TONE[summary.outcome] ?? "muted")}
      <span class="muted">duration ${summary.outcome === "running" ? "so far " : ""}${formatDuration(summary.durationMs)}</span>
      <span class="muted">${summary.reviews.length} reviews</span></div>
      ${summary.rejections.length > 0 ? h`<ul class="reasons">${summary.rejections.slice(0, 3).map((r) => h`<li>${r}</li>`)}</ul>` : ""}
      ${pipelinesOf(run, state).slice(0, 2).map(pipeline)}`,
    h`<a class="link small" href="#runs">History →</a>`,
  );
}

const verdictTone = (state: string): BadgeTone =>
  state === "clear" ? "ok" : state === "waiting" ? "warn" : "bad";

function debtBlockersCard(state: DashboardState) {
  if (state.debt === null) {
    return card(
      h`Debt blockers ${provenance("unavailable")}`,
      h`<p class="muted">The register or tickets could not be evaluated.</p>`,
    );
  }
  const { held } = state.debt;
  return card(
    "Debt blockers",
    held.length === 0
      ? empty("Nothing held", "No unfinished ticket is held by the debt gate.", "ok")
      : h`<ul class="list">${held
          .slice(0, 6)
          .map(
            ({ ticket, verdict: v }) =>
              h`<li>${ticketLink(ticket)} ${badge(v.state, verdictTone(v.state))} <span class="muted small clamp">${v.reasons[0] ?? ""}</span></li>`,
          )}</ul>${held.length > 6 ? h`<p class="muted small">and ${held.length - 6} more</p>` : ""}`,
    h`<a class="link small" href="#debt">All debt →</a>`,
  );
}

function activityCard(state: DashboardState) {
  const items = recentActivity(state, 10);
  return card(
    h`Recent activity ${provenance("historical")}`,
    items.length === 0
      ? empty("Quiet", "No timed sessions or failures on record.")
      : h`<ol class="feed">${items.map(
          (item) =>
            h`<li>${dot(item.tone)}<div><div>${item.title}</div><div class="muted small">${when(item.at)} · ${item.detail}</div></div></li>`,
        )}</ol>`,
  );
}

function gapsCard(state: DashboardState) {
  return card(
    h`Unavailable sources ${state.gaps.length > 0 ? provenance("unavailable") : ""}`,
    state.gaps.length === 0
      ? empty("Every source was read", "", "ok")
      : h`<ul class="plain">${state.gaps.map((gap) => h`<li><code>${gap.source}</code>: ${gap.reason}</li>`)}</ul>`,
  );
}

function overviewView(state: DashboardState, now: number) {
  return h`<div class="view-head"><div><h2>Overview</h2>
    <p class="muted">Statuses are the <code>**Status:**</code> lines on <code>${state.source.ref}</code>, verbatim. ${calc} marks values calculated from Ralph's rules.</p></div></div>
    ${kpis(state)}
    <div class="grid-2">${executionCard(state, now)}${latestRunCard(state, now)}</div>
    <div class="grid-3">${debtBlockersCard(state)}${activityCard(state)}${gapsCard(state)}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Ticket board

const blockerChip = (status: string | null) =>
  status === "done" ? "chip-ok" : status === null ? "chip-bad" : "chip-warn";

function ticketCard(ticket: TicketView) {
  const eligibility = eligibilityOf(ticket);
  const key = ticketKey(ticket.number);
  const search = `${ticket.number} ${ticket.title} ${ticket.slug} ${ticket.status}`;
  const percent =
    ticket.criteria.total === 0
      ? 0
      : Math.round((100 * ticket.criteria.checked) / ticket.criteria.total);
  return h`<a class="tcard" href="#d-${key}" data-detail="${key}" data-card data-eligibility="${eligibility}" data-search="${search}">
    <div class="tcard-top"><span class="mono muted">#${ticket.number}</span>${ticket.pause ? badge("paused", "warn", `${ticket.pause.reason} in ${ticket.pause.phase}`) : ""}${ticket.problems.length > 0 ? badge("contract", "bad", ticket.problems.join("\n")) : ""}</div>
    <div class="tcard-title">${ticket.title}</div>
    ${ticket.blockers.length > 0 ? h`<div class="chips">${ticket.blockers.map((b) => h`<span class="chip mono ${blockerChip(b.status)}" title="${`blocked by #${b.number}: ${b.status ?? "no such ticket"}`}">↳ ${b.number}</span>`)}</div>` : ""}
    <div class="tcard-foot">
      ${eligibility === "not-applicable" ? "" : eligibilityBadge(eligibility)}
      ${ticket.phase ? h`<span class="small muted" title="${`last session in run ${ticket.phase.runId} (${ticket.phase.liveness})`}">${dot(ticket.phase.liveness === "live" ? "live" : "muted")}${ticket.phase.session.phase}</span>` : ""}
      <span class="spacer"></span>
      <span class="small muted" title="Acceptance criteria checked">${ticket.criteria.checked}/${ticket.criteria.total}</span>
    </div>
    <div class="progress"><span style="${raw(`width:${percent}%`)}"></span></div>
  </a>`;
}

const ELIGIBILITY_FILTERS: Eligibility[] = [
  "eligible",
  "waiting-blockers",
  "waiting-debt",
  "debt-triage",
  "unknown",
];

function boardToolbar() {
  return h`<div class="toolbar" role="search">
    <input id="board-search" type="search" placeholder="Search id, title…" aria-label="Search tickets" autocomplete="off">
    <select id="board-status" aria-label="Status">
      <option value="open">All but done</option><option value="all">All statuses</option>
      <option value="ready-for-agent">ready-for-agent</option><option value="in-progress">in-progress</option>
      <option value="blocked">blocked</option><option value="ready-for-human">ready-for-human</option>
      <option value="done">done</option><option value="unrecognized">unrecognized</option>
    </select>
    <select id="board-eligibility" aria-label="Eligibility (calculated)">
      <option value="any">Any eligibility</option>
      ${ELIGIBILITY_FILTERS.map((e) => h`<option value="${e}">calc: ${ELIGIBILITY_LABEL[e]}</option>`)}
    </select>
  </div>`;
}

function boardColumnsHtml(state: DashboardState) {
  if (state.tickets === null) {
    return card(
      h`Tickets ${provenance("unavailable")}`,
      h`<p>Ticket files could not be read; see Unavailable sources.</p>`,
    );
  }
  return h`<div class="board">${boardColumns(state.tickets).map(
    (column) => h`<section class="column" data-column="${column.key}">
      <header class="column-head">${dot(STATUS_TONE[column.key] ?? "bad")}<span>${column.title}</span><span class="count" data-shown>${column.tickets.length}</span></header>
      <div class="column-body">${column.tickets.map(ticketCard)}<p class="muted small empty-col" data-empty${column.tickets.length > 0 ? raw(" hidden") : ""}>No matching tickets</p></div>
    </section>`,
  )}</div>`;
}

function boardView(state: DashboardState) {
  return h`<div class="view-head"><div><h2>Ticket Board</h2>
    <p class="muted">Columns are the status line, verbatim; nothing here changes or infers it. The dashed ${calc} badge is Ralph's selection rule applied to that status.</p></div></div>
    ${boardToolbar()}
    <div data-region="board">${boardColumnsHtml(state)}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Technical debt

const SEVERITY_CLASS: Record<string, string> = {
  CRITICAL: "sev-critical",
  HIGH: "sev-high",
  MEDIUM: "sev-medium",
  LOW: "sev-low",
};
const sevClass = (severity: string) => SEVERITY_CLASS[severity] ?? "sev-other";

function severityChart(debt: NonNullable<DashboardState["debt"]>) {
  const rows = severityDistribution(debt.entries);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const segment = (severity: string, kind: string, n: number) =>
    n > 0
      ? h`<span class="seg seg-${kind}" style="${raw(`width:${((100 * n) / max).toFixed(2)}%`)}" title="${`${severity}: ${n} ${kind}`}"></span>`
      : "";
  return h`<div class="sevchart" role="img" aria-label="Debt entries by severity and status">
    ${rows.map(
      (row) => h`<div class="sevrow">
        <span class="sevlabel">${row.severity}</span>
        <div class="sevbar ${sevClass(row.severity)}">${segment(row.severity, "open", row.open)}${segment(row.severity, "planned", row.planned)}${segment(row.severity, "resolved", row.resolved)}</div>
        <span class="sevnums mono small" title="open / planned / resolved">${row.open} / ${row.planned} / ${row.resolved}</span>
      </div>`,
    )}
    <div class="legend small"><span><span class="swatch seg-open"></span>open</span><span><span class="swatch seg-planned"></span>planned</span><span><span class="swatch seg-resolved"></span>resolved</span><span class="muted">numbers: open / planned / resolved</span></div>
  </div>`;
}

function debtView(state: DashboardState) {
  if (state.debt === null) {
    return h`<div class="view-head"><div><h2>Technical Debt</h2></div></div>${card(h`Register ${provenance("unavailable")}`, h`<p>The register or tickets could not be evaluated; see Unavailable sources on the overview.</p>`)}`;
  }
  const counts = debtCounts(state.debt.entries);
  const actionable = prioritizedDebt(state.debt.entries, state.debt.held);
  const heldCount = state.debt.held.length;
  return h`<div class="view-head"><div><h2>Technical Debt</h2>
    <p class="muted">Verdicts from <code>scripts/ralph-debt.mjs</code> <code>debtGate</code> over <code>docs/technical-debt.md</code> at <code>${state.source.ref}</code>: the computation Ralph's selection uses.</p></div></div>
    <div class="kpis kpis-4">
      ${kpi("Open", counts.open, "bad", "no plan yet", "#debt")}
      ${kpi("Planned", counts.planned, "warn", "has a target", "#debt")}
      ${kpi("Resolved", counts.resolved, "ok", "fixed and verified", "#debt")}
      ${kpi("Tickets held", heldCount, heldCount > 0 ? "warn" : "ok", h`${calc}by the debt gate`, "#debt")}
    </div>
    ${counts.other > 0 ? h`<p class="muted small">${counts.other} entries carry a status other than ${DEBT_STATUSES.join(", ")}.</p>` : ""}
    <div class="grid-2">
      ${card("Severity distribution", severityChart(state.debt))}
      ${card(
        "Blocking dependencies",
        heldCount === 0
          ? empty("No ticket is held", "Every unfinished ticket passes the debt gate.", "ok")
          : h`<ul class="list">${state.debt.held.map(
              ({ ticket, verdict: v }) =>
                h`<li class="held">${ticketLink(ticket)} ${badge(v.state, verdictTone(v.state))}<ul class="reasons">${v.reasons.map((r) => h`<li>${r}</li>`)}</ul></li>`,
            )}</ul>`,
      )}
    </div>
    ${card(
      h`Actionable findings <span class="muted small">${actionable.length} unresolved, most actionable first</span>`,
      actionable.length === 0
        ? empty("Nothing open", "Every entry is resolved.", "ok")
        : h`<ul class="findings">${actionable.map(
            ({ entry, holding }) =>
              h`<li>${detailLink(
                debtKey(entry.id),
                h`<span class="sevpill ${sevClass(entry.severity)}">${entry.severity}</span>
              <span class="mono muted">${entry.id}</span>
              <span class="finding-title">${entry.title}</span>
              <span class="spacer"></span>
              ${holding.length > 0 ? badge(`holds ${holding.map((t) => `#${t}`).join(" ")}`, "bad", "Cited by the debt gate right now") : ""}
              ${entry.blocks.length > 0 ? h`<span class="small muted">blocks ${entry.blocks.join(", ")}</span>` : ""}
              ${badge(entry.status, entry.status === "OPEN" ? "warn" : "muted")}`,
                "finding",
              )}</li>`,
          )}</ul>`,
    )}`;
}

// ---------------------------------------------------------------------------------------------
// Detail drawer

const reviewBlock = (review: TicketView["review"]["loop"]) =>
  review
    ? h`${verdict(review.decision.verdict)} <span class="muted small">${review.run}${review.round === null ? "" : ` r${review.round}`}</span>${review.decision.blockers.map((b) => h`<div class="small">[${b.severity}] ${b.axis}: ${b.title}</div>`)}`
    : h`<span class="muted">none on record</span>`;

function debtGateBlock(ticket: TicketView) {
  if (ticket.status === "done") {
    return h`<span class="muted">n/a</span>`;
  }
  if (ticket.debt === null) {
    return provenance("unavailable");
  }
  return h`${badge(ticket.debt.state, verdictTone(ticket.debt.state))}<ul class="reasons">${ticket.debt.reasons.map((r) => h`<li>${r}</li>`)}</ul>`;
}

function ticketDetail(ticket: TicketView) {
  const eligibility = eligibilityOf(ticket);
  const key = ticketKey(ticket.number);
  return h`<article class="detail" id="d-${key}" data-detail-id="${key}">
    <p class="mono muted">Ticket #${ticket.number} · ${ticket.location === "done" ? "issues/done" : "issues"}</p>
    <h3>${ticket.title}</h3>
    <dl class="kv">
      <dt>Status</dt><dd>${ticketStatus(ticket)} <span class="muted small">verbatim from the ticket file</span></dd>
      <dt>Eligibility</dt><dd>${eligibility === "not-applicable" ? h`<span class="muted">only computed for ready-for-agent</span>` : eligibilityBadge(eligibility)}</dd>
      <dt>Blocked by</dt><dd>${ticket.blockers.length === 0 ? h`<span class="muted">none</span>` : ticket.blockers.map((b) => h`<div>${ticketLink(b.number)} ${b.status === null ? badge("no such ticket", "bad") : badge(b.status, b.status === "done" ? "ok" : "warn")}</div>`)}</dd>
      <dt>Debt gate</dt><dd>${debtGateBlock(ticket)}</dd>
      <dt>Agent phase</dt><dd>${ticket.phase === null ? h`<span class="muted">no run logs</span>` : h`${liveness(ticket.phase.liveness)} <code>${ticket.phase.session.label}</code> ${sessionStatus(ticket.phase.session.status)} <span class="muted small">run ${ticket.phase.runId}</span>`}</dd>
      <dt>Loop review</dt><dd>${reviewBlock(ticket.review.loop)}</dd>
      <dt>Host review</dt><dd>${reviewBlock(ticket.review.host)}</dd>
      ${ticket.pause ? h`<dt>Paused</dt><dd>${ticket.pause.reason} in ${ticket.pause.phase} (attempt ${ticket.pause.attempt}, round ${ticket.pause.round}), run ${ticket.pause.run}</dd>` : ""}
      ${ticket.completion ? h`<dt>Completed</dt><dd>${ticket.completion.date} · <code>${ticket.completion.branch}</code> · run ${ticket.completion.run}</dd>` : ""}
      <dt>Criteria</dt><dd>${ticket.criteria.checked}/${ticket.criteria.total} checked</dd>
      ${ticket.problems.length > 0 ? h`<dt>Contract</dt><dd><ul class="reasons">${ticket.problems.map((p) => h`<li>${p}</li>`)}</ul></dd>` : ""}
    </dl>
  </article>`;
}

function debtDetails(debt: NonNullable<DashboardState["debt"]>) {
  const resolved = debt.entries
    .filter((entry) => entry.status === "RESOLVED")
    .map((entry) => ({ entry, holding: [] as string[] }));
  return [...prioritizedDebt(debt.entries, debt.held), ...resolved].map(
    ({
      entry,
      holding,
    }) => h`<article class="detail" id="d-${debtKey(entry.id)}" data-detail-id="${debtKey(entry.id)}">
      <p class="mono muted">${entry.id}</p><h3>${entry.title}</h3>
      <dl class="kv">
        <dt>Status</dt><dd>${badge(entry.status, entry.status === "RESOLVED" ? "ok" : entry.status === "OPEN" ? "warn" : "muted")}</dd>
        <dt>Severity</dt><dd><span class="sevpill ${sevClass(entry.severity)}">${entry.severity}</span></dd>
        <dt>Risk</dt><dd>${entry.risk}</dd>
        <dt>Triage</dt><dd>${entry.triage}</dd>
        <dt>Target</dt><dd>${entry.target}</dd>
        <dt>Blocks</dt><dd>${entry.blocks.length === 0 ? h`<span class="muted">none</span>` : entry.blocks.map(ticketLink)}</dd>
        <dt>Holding now</dt><dd>${holding.length === 0 ? h`<span class="muted">not cited by the debt gate</span>` : holding.map(ticketLink)}</dd>
      </dl></article>`,
  );
}

function drawer(state: DashboardState) {
  return h`<div class="drawer" id="drawer">
    <a class="scrim" href="#" data-close aria-label="Close details"></a>
    <aside class="panel" aria-label="Details">
      <a class="close" href="#" data-close aria-label="Close details">✕</a>
      <div data-region="details">${(state.tickets ?? []).map(ticketDetail)}${state.debt ? debtDetails(state.debt) : ""}</div>
    </aside>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Shell

function nav(state: DashboardState) {
  const execution = executionStatus(state);
  const counts = state.tickets ? ticketCounts(state.tickets) : null;
  const held = state.debt?.held.length ?? 0;
  const item = (view: string, label: string, extra: Html | string) =>
    h`<a href="#${view}" data-nav="${view}">${icon(view)}<span>${label}</span>${extra}</a>`;
  return h`${item("overview", "Overview", "")}
    ${item("board", "Ticket Board", counts ? h`<span class="count" title="tickets not done">${counts.total - counts.done}</span>` : "")}
    ${item("agents", "Agent Activity", dot(EXECUTION_TONE[execution.kind]))}
    ${item("debt", "Technical Debt", held > 0 ? h`<span class="count t-warn" title="tickets held">${held}</span>` : "")}
    ${item("runs", "Run History", h`<span class="count">${state.runs.length}</span>`)}`;
}

export function renderPage(state: DashboardState, options: { refreshSeconds: number }): string {
  const now = Date.parse(state.generatedAt);
  const fallbackRefresh =
    options.refreshSeconds > 0
      ? h`<noscript><meta http-equiv="refresh" content="${options.refreshSeconds}"></noscript>`
      : "";
  const execution = executionStatus(state);
  return h`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${fallbackRefresh}
<title>Ralph Control Center</title><style>${raw(STYLE)}</style>
<script type="module" src="/assets/dashboard.js"></script></head>
<body data-refresh="${options.refreshSeconds}">
<div class="app">
<nav class="sidebar" aria-label="Views">
  <div class="brand"><span class="logo" aria-hidden="true">R</span><div><div class="brand-name">Ralph</div><div class="muted small">Control Center</div></div></div>
  <div class="nav" data-region="nav">${nav(state)}</div>
  <div class="sidebar-foot small muted" data-region="source">
    <div>${badge("read-only", "info")}</div>
    <div>ref <code>${state.source.ref}</code> @ <code>${state.source.commit?.slice(0, 10) ?? "missing"}</code></div>
    <div class="clamp" title="${state.source.root}">${state.source.root}</div>
  </div>
</nav>
<div class="content">
  <header class="topbar">
    <div class="topbar-status" data-region="status">${dot(EXECUTION_TONE[execution.kind])}<span>${EXECUTION_LABEL[execution.kind]}</span><span class="muted small">generated ${when(state.generatedAt)} UTC</span></div>
    <div class="topbar-actions"><span id="refresh-stamp" class="small muted">${options.refreshSeconds > 0 ? `refreshes every ${options.refreshSeconds}s` : "auto-refresh off"}</span>
      <button type="button" id="refresh-toggle" class="btn" aria-pressed="false">Pause</button>
      <button type="button" id="refresh-now" class="btn">Refresh</button></div>
  </header>
  <main>
    <section class="view" id="overview" data-view="overview"><div data-region="overview">${overviewView(state, now)}</div></section>
    <section class="view" id="board" data-view="board">${boardView(state)}</section>
    <section class="view" id="agents" data-view="agents"><div data-region="agents">${agentsView(state, now)}</div></section>
    <section class="view" id="debt" data-view="debt"><div data-region="debt">${debtView(state)}</div></section>
    <section class="view" id="runs" data-view="runs"><div data-region="runs">${runsView(state, now)}</div></section>
  </main>
</div>
</div>
${drawer(state)}
</body></html>`.html;
}
