// Server-rendered HTML: no client framework, no script. Every artifact value is escaped, because
// ticket titles, review text and branch subjects are written by agents and are untrusted here.

import type { Gap, Provenance, Session } from "./model";
import type {
  DashboardState,
  FailureView,
  Liveness,
  ReviewView,
  RunView,
  TicketView,
} from "./state";

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type Html = { readonly html: string };
const raw = (html: string): Html => ({ html });

/** Tagged template that escapes every interpolated value unless it is already `Html`. */
function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return raw(out);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  if (typeof value === "object" && "html" in value && typeof value.html === "string") {
    return value.html;
  }
  return escapeHtml(String(value));
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  live: "LIVE",
  historical: "HISTORICAL",
  unavailable: "UNAVAILABLE",
};
const tag = (provenance: Provenance, title?: string) =>
  h`<span class="tag ${provenance}" title="${title ?? ""}">${PROVENANCE_LABEL[provenance]}</span>`;

const LIVENESS: Record<Liveness, { cls: string; label: string }> = {
  live: { cls: "live", label: "live" },
  stale: { cls: "stale", label: "stale: claims active" },
  finished: { cls: "historical", label: "finished" },
  unknown: { cls: "unavailable", label: "unknown" },
};
const liveness = (value: Liveness) =>
  h`<span class="tag ${LIVENESS[value].cls}">${LIVENESS[value].label}</span>`;

const pill = (text: string, cls: string) => h`<span class="pill ${cls}">${text}</span>`;
const STATUS_CLASS: Record<string, string> = {
  done: "ok",
  "ready-for-agent": "info",
  "in-progress": "live",
  blocked: "bad",
  "ready-for-human": "muted",
};
const ticketStatus = (ticket: TicketView) =>
  ticket.statusRecognized
    ? pill(ticket.status, STATUS_CLASS[ticket.status] ?? "muted")
    : pill(`unrecognized: ${ticket.status || "(missing)"}`, "bad");

const ago = (ms: number | null, now: number): string => {
  if (ms === null) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

const sessionText = (session: Session) =>
  h`<code>${session.label}</code> ${pill(session.status, session.status === "ok" ? "ok" : session.status === "running" ? "live" : "bad")}`;

function verdictPill(review: ReviewView | null) {
  if (review === null) {
    return h`<span class="muted">none on record</span>`;
  }
  const cls = review.decision.verdict === "approved" ? "ok" : "bad";
  const round = review.round === null ? "" : ` r${review.round}`;
  return h`${pill(review.decision.verdict, cls)} <span class="muted">${review.run}${round}</span>`;
}

function blockersCell(ticket: TicketView) {
  if (ticket.blockers.length === 0) {
    return h`<span class="muted">none</span>`;
  }
  return ticket.blockers.map(
    (blocker) =>
      h`<span class="pill ${blocker.status === "done" ? "ok" : blocker.status === null ? "bad" : "warn"}" title="${blocker.status ?? "no such ticket"}">${blocker.number}</span> `,
  );
}

function debtCell(ticket: TicketView) {
  if (ticket.status === "done") {
    return h`<span class="muted">n/a</span>`;
  }
  if (ticket.debt === null) {
    return tag("unavailable", "debt gate could not be computed");
  }
  const cls = { clear: "ok", waiting: "warn", "needs-triage": "bad" }[ticket.debt.state];
  return h`<span title="${ticket.debt.reasons.join("\n")}">${pill(ticket.debt.state, cls)}</span>`;
}

function phaseCell(ticket: TicketView) {
  if (ticket.phase === null) {
    return h`<span class="muted">no run logs</span>`;
  }
  const { session, runId } = ticket.phase;
  return h`${liveness(ticket.phase.liveness)} ${sessionText(session)} <span class="muted">${runId}</span>`;
}

function ticketRow(ticket: TicketView) {
  const selectable = ticket.selectable === null ? "?" : ticket.selectable ? "yes" : "no";
  return h`<tr>
    <td><b>${ticket.number}</b></td>
    <td>${ticket.title}${ticket.problems.length > 0 ? h` <span class="pill bad" title="${ticket.problems.join("\n")}">contract</span>` : ""}${ticket.pause ? h` <span class="pill warn" title="${`${ticket.pause.reason} in ${ticket.pause.phase}`}">paused</span>` : ""}</td>
    <td>${ticketStatus(ticket)}</td>
    <td>${blockersCell(ticket)}</td>
    <td>${debtCell(ticket)}</td>
    <td>${ticket.status === "ready-for-agent" ? selectable : h`<span class="muted">n/a</span>`}</td>
    <td>${phaseCell(ticket)}</td>
    <td>${verdictPill(ticket.review.loop)}</td>
    <td>${verdictPill(ticket.review.host)}</td>
    <td>${ticket.criteria.checked}/${ticket.criteria.total}</td>
  </tr>`;
}

const TICKET_HEAD = h`<thead><tr><th>#</th><th>Ticket</th><th>Status</th><th>Blocked by</th>
  <th>Debt gate</th><th title="ready-for-agent, blockers done, debt gate clear">Selectable</th>
  <th>Agent phase</th><th>Loop review</th><th>Host review</th><th>AC</th></tr></thead>`;

function ticketsSection(state: DashboardState) {
  if (state.tickets === null) {
    return h`<section><h2>Tickets ${tag("unavailable")}</h2><p>Ticket files could not be read; see Unavailable sources.</p></section>`;
  }
  const active = state.tickets.filter((t) => t.location === "active");
  const done = state.tickets.filter((t) => t.location === "done");
  return h`<section><h2>Tickets ${tag("live", "ticket files at the ref")}</h2>
    <p class="muted">Statuses are the <code>**Status:**</code> lines on <code>${state.source.ref}</code>, verbatim. Agent phase and reviews come from run logs (kept 30 days).</p>
    <div class="scroll"><table>${TICKET_HEAD}<tbody>${active.map(ticketRow)}</tbody></table></div>
    <details><summary>${done.length} archived tickets (issues/done)</summary>
    <div class="scroll"><table>${TICKET_HEAD}<tbody>${done.map(ticketRow)}</tbody></table></div></details>
  </section>`;
}

function runRow(run: RunView, now: number) {
  const last = run.sessions.at(-1);
  return h`<tr>
    <td><code>${run.runId}</code></td><td>${run.origin}</td>
    <td>${liveness(run.liveness)} ${run.status === null ? tag("unavailable", "run.json missing or unreadable") : h`<code>${run.status}</code>`}</td>
    <td>${run.tickets.join(", ")}</td>
    <td>${run.current ? sessionText(run.current) : last ? sessionText(last) : h`<span class="muted">no sessions</span>`}</td>
    <td>${run.sessions.length}</td>
    <td>${ago(run.lastActivity, now)}</td>
  </tr>`;
}

const RUN_HEAD = h`<thead><tr><th>Run</th><th>Origin</th><th>State</th><th>Tickets</th>
  <th>Current / last session</th><th>Sessions</th><th>Last file activity</th></tr></thead>`;

function currentSection(state: DashboardState, now: number) {
  const { runs, batch, lock, pauses, pausedBranches } = state.current;
  const lockText = lock.held
    ? h`held by pid ${lock.owner?.pid ?? "unknown"} on ${lock.owner?.host ?? "unknown host"} since ${lock.owner?.startedAt ?? "unknown"} <span class="muted">(holder's liveness not verified)</span>`
    : h`<span class="muted">not held</span>`;
  const batchText = batch.value
    ? h`${tag(batch.provenance)} <code>${batch.value.batch}</code> status <code>${batch.value.status}</code>${batch.value.stop ? h`, stopped <code>${batch.value.stop.reason}</code>: ${batch.value.stop.detail}` : ""}`
    : tag("unavailable", "no .ralph/batch/state.json");
  return h`<section><h2>Current runs</h2>
    <p class="muted">A run is <b>live</b> while run.json says <code>active</code> and its files changed in the last ${state.staleAfterMinutes} min. <b>stale</b> means it still claims <code>active</code> but has been quiet: a killed run stays <code>active</code> forever, and process liveness is not checked.</p>
    ${runs.length === 0 ? h`<p>No run claims to be active.</p>` : h`<div class="scroll"><table>${RUN_HEAD}<tbody>${runs.map((run) => runRow(run, now))}</tbody></table></div>`}
    <dl>
      <dt>Batch lock</dt><dd>${lockText}</dd>
      <dt>Last batch</dt><dd>${batchText}</dd>
      <dt>Paused tickets</dt><dd>${pauses.length === 0 ? h`<span class="muted">none in .ralph/state</span>` : pauses.map((p) => h`<div>ticket ${p.ticket}: ${p.reason} in ${p.phase} (attempt ${p.attempt}, round ${p.round}), run ${p.run}</div>`)}</dd>
      <dt>Parked branches</dt><dd>${pausedBranches.length === 0 ? h`<span class="muted">none</span>` : pausedBranches.map((b) => h`<div><code>${b.name}</code> ${b.date}</div>`)}</dd>
    </dl>
  </section>`;
}

function debtSection(state: DashboardState) {
  if (state.debt === null) {
    return h`<section><h2>Technical debt blockers ${tag("unavailable")}</h2><p>The register or tickets could not be evaluated; see Unavailable sources.</p></section>`;
  }
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const summaryRows = Object.entries(state.debt.summary).map(
    ([status, row]) =>
      h`<tr><td><code>${status}</code></td>${severities.map((s) => h`<td>${row[s] ?? 0}</td>`)}</tr>`,
  );
  return h`<section><h2>Technical debt blockers ${tag("live", "debt gate computed by scripts/ralph-debt.mjs")}</h2>
    <p class="muted">Verdicts from <code>scripts/ralph-debt.mjs</code> <code>debtGate</code> over the register and tickets at <code>${state.source.ref}</code>, the same computation Ralph's selection uses.</p>
    ${state.debt.held.length === 0 ? h`<p>No unfinished ticket is held by debt.</p>` : h`<div class="scroll"><table><thead><tr><th>Ticket</th><th>Verdict</th><th>Reasons</th></tr></thead><tbody>${state.debt.held.map((held) => h`<tr><td><b>${held.ticket}</b></td><td>${pill(held.verdict.state, held.verdict.state === "waiting" ? "warn" : "bad")}</td><td><ul>${held.verdict.reasons.map((r) => h`<li>${r}</li>`)}</ul></td></tr>`)}</tbody></table></div>`}
    <details><summary>Register summary (${state.debt.entries.length} entries)</summary>
    <table><thead><tr><th>Status</th>${severities.map((s) => h`<th>${s}</th>`)}</tr></thead><tbody>${summaryRows}</tbody></table></details>
  </section>`;
}

function failureRow(failure: FailureView) {
  return h`<tr><td>${failure.at}</td><td>${pill(failure.kind, "bad")}</td><td>${failure.ticket ?? ""}</td><td>${failure.detail}</td><td class="muted">${failure.source}</td></tr>`;
}

function failuresSection(state: DashboardState) {
  return h`<section><h2>Recent failures ${tag("historical")}</h2>
    ${state.failures.length === 0 ? h`<p>None on record.</p>` : h`<div class="scroll"><table><thead><tr><th>When</th><th>Kind</th><th>Ticket</th><th>Detail</th><th>Source</th></tr></thead><tbody>${state.failures.map(failureRow)}</tbody></table></div>`}
  </section>`;
}

function reviewRow(review: ReviewView) {
  const findings = Object.entries(review.decision.findings)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");
  return h`<tr><td><code>${review.run}</code></td><td>${review.kind}${review.round === null ? "" : ` r${review.round}`}</td><td>${review.slug}</td>
    <td>${pill(review.decision.verdict, review.decision.verdict === "approved" ? "ok" : "bad")}</td>
    <td>${review.decision.blockers.map((b) => h`<div>[${b.severity}] ${b.axis}: ${b.title}</div>`)}${review.decision.errors > 0 ? h`<div>${review.decision.errors} evidence errors</div>` : ""}</td>
    <td>${findings || h`<span class="muted">none</span>`}</td></tr>`;
}

function historySection(state: DashboardState, now: number) {
  return h`<section><h2>Run and review history ${tag("historical")}</h2>
    <details><summary>${state.runs.length} runs in .ralph/logs and sandboxes</summary>
    <div class="scroll"><table>${RUN_HEAD}<tbody>${state.runs.map((run) => runRow(run, now))}</tbody></table></div></details>
    <details><summary>${state.reviews.length} review decisions</summary>
    <div class="scroll"><table><thead><tr><th>Run</th><th>Kind</th><th>Ticket</th><th>Verdict</th><th>Blockers</th><th>Findings</th></tr></thead><tbody>${state.reviews.map(reviewRow)}</tbody></table></div></details>
  </section>`;
}

function gapsSection(gaps: Gap[]) {
  return h`<section><h2>Unavailable sources ${tag("unavailable")}</h2>
    ${gaps.length === 0 ? h`<p>Every source was read.</p>` : h`<ul>${gaps.map((gap) => h`<li><code>${gap.source}</code>: ${gap.reason}</li>`)}</ul>`}
  </section>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e2e1dc;
--ok:#1f7a3a;--okbg:#e3f3e7;--bad:#a32020;--badbg:#fbe5e5;--warn:#8a5a00;--warnbg:#fdf0d5;
--info:#1d4f91;--infobg:#e3ecf8;--live:#0b6e66;--livebg:#d7f2ee;--hist:#55554f;--histbg:#ecebe6}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#e9e8e3;--muted:#9a9993;--card:#1f1f1d;
--line:#33332f;--ok:#7fd49a;--okbg:#17321f;--bad:#f19a9a;--badbg:#3a1a1a;--warn:#f2c46b;--warnbg:#3a2d10;
--info:#9cc0f2;--infobg:#172840;--live:#6fe0d3;--livebg:#103430;--hist:#c2c1ba;--histbg:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header,main{max-width:1400px;margin:0 auto;padding:16px}header h1{margin:0 0 4px;font-size:20px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:0 0 16px}
h2{font-size:16px;margin:4px 0 8px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:600}.scroll{overflow-x:auto}
code{font:12px ui-monospace,monospace}.muted{color:var(--muted)}ul{margin:0;padding-left:18px}
.pill,.tag{display:inline-block;padding:0 6px;border-radius:9px;font-size:12px;white-space:nowrap}
.tag{font-weight:700;letter-spacing:.03em;font-size:11px;border-radius:3px}
.ok{color:var(--ok);background:var(--okbg)}.bad{color:var(--bad);background:var(--badbg)}
.warn,.stale{color:var(--warn);background:var(--warnbg)}.info{color:var(--info);background:var(--infobg)}
.live{color:var(--live);background:var(--livebg)}.historical,.muted.pill{color:var(--hist);background:var(--histbg)}
.unavailable{color:var(--bad);background:repeating-linear-gradient(45deg,var(--badbg) 0 4px,transparent 4px 8px)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}dt{color:var(--muted)}dd{margin:0}
summary{cursor:pointer;margin:8px 0}`;

export function renderPage(state: DashboardState, options: { refreshSeconds: number }): string {
  const now = Date.parse(state.generatedAt);
  const refresh =
    options.refreshSeconds > 0
      ? h`<meta http-equiv="refresh" content="${options.refreshSeconds}">`
      : "";
  const body = h`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>Ralph Control Center</title><style>${raw(STYLE)}</style></head><body>
<header><h1>Ralph Control Center <span class="muted">read-only</span></h1>
<div class="muted">Root <code>${state.source.root}</code> · ref <code>${state.source.ref}</code> @ <code>${state.source.commit?.slice(0, 10) ?? "missing"}</code> · generated ${state.generatedAt}${options.refreshSeconds > 0 ? ` · refreshes every ${options.refreshSeconds}s` : ""}</div>
<div>${tag("live")} describes the present · ${tag("historical")} a finished record · ${tag("unavailable")} missing or unreadable</div></header>
<main>${currentSection(state, now)}${ticketsSection(state)}${debtSection(state)}${failuresSection(state)}${historySection(state, now)}${gapsSection(state.gaps)}</main>
</body></html>`;
  return body.html;
}
