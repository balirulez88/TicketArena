// Small presentational building blocks shared by the views. Every status colour on the page comes
// from one tone vocabulary, and every tone is paired with a text label, never colour alone.

import { type Html, h, raw } from "./html";
import type { Provenance } from "./model";
import { ELIGIBILITY_LABEL, type Eligibility, type StageState, type Tone } from "./present";
import type { Liveness, TicketView } from "./state";

export type BadgeTone = Tone | "info";

export const badge = (text: string, tone: BadgeTone, title = "") =>
  h`<span class="badge t-${tone}"${title ? h` title="${title}"` : ""}>${text}</span>`;

export const dot = (tone: BadgeTone) => h`<span class="dot t-${tone}" aria-hidden="true"></span>`;

export const STATUS_TONE: Record<string, BadgeTone> = {
  "ready-for-agent": "info",
  "in-progress": "live",
  blocked: "bad",
  "ready-for-human": "warn",
  done: "ok",
};

/** The ticket's `**Status:**` value verbatim; an unrecognized value is flagged, not mapped. */
export const ticketStatus = (ticket: TicketView) =>
  ticket.statusRecognized
    ? badge(ticket.status, STATUS_TONE[ticket.status] ?? "muted", "Status line at the ref")
    : badge(`unrecognized: ${ticket.status || "(missing)"}`, "bad", "Status line at the ref");

const ELIGIBILITY_TONE: Record<Eligibility, BadgeTone> = {
  eligible: "ok",
  "waiting-blockers": "warn",
  "waiting-debt": "warn",
  "debt-triage": "bad",
  unknown: "muted",
  "not-applicable": "muted",
};

/** Calculated values wear a dashed outline and a `calc` prefix so they never pass for a status. */
export const eligibilityBadge = (eligibility: Eligibility) =>
  h`<span class="badge calc t-${ELIGIBILITY_TONE[eligibility]}" title="Calculated from Ralph's selection rule: ready-for-agent, every blocker done, debt gate clear"><span class="calc-mark">calc</span>${ELIGIBILITY_LABEL[eligibility]}</span>`;

const PROVENANCE: Record<Provenance, { label: string; tone: BadgeTone; title: string }> = {
  live: { label: "LIVE", tone: "live", title: "Describes the present" },
  historical: { label: "HISTORICAL", tone: "muted", title: "A record of something finished" },
  unavailable: { label: "UNAVAILABLE", tone: "bad", title: "Missing or unreadable source" },
};
export const provenance = (value: Provenance) =>
  h`<span class="tag tag-${value}" title="${PROVENANCE[value].title}">${PROVENANCE[value].label}</span>`;

const LIVENESS: Record<Liveness, { label: string; tone: BadgeTone }> = {
  live: { label: "live", tone: "live" },
  stale: { label: "stale: claims active", tone: "warn" },
  finished: { label: "finished", tone: "muted" },
  unknown: { label: "unknown", tone: "bad" },
};
export const liveness = (value: Liveness) =>
  badge(
    LIVENESS[value].label,
    LIVENESS[value].tone,
    "Run liveness from run.json and file activity",
  );

export const STAGE_TONE: Record<StageState, BadgeTone> = {
  active: "live",
  completed: "ok",
  failed: "bad",
  stale: "warn",
  unknown: "muted",
};

const SESSION_TONE: Record<string, BadgeTone> = {
  running: "live",
  ok: "ok",
  failed: "bad",
  "timed-out": "bad",
  interrupted: "bad",
};
export const sessionStatus = (status: string) => badge(status, SESSION_TONE[status] ?? "muted");

export const verdict = (value: string) => badge(value, value === "approved" ? "ok" : "bad");

export const ago = (ms: number | null, now: number): string => {
  if (ms === null) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 90) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/** ISO time shown compactly; anything unparseable is shown verbatim rather than guessed. */
export const when = (iso: string | null): string => {
  if (iso === null) {
    return "unknown";
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : iso;
};

export const empty = (title: string, text: Html | string, tone: BadgeTone = "muted") =>
  h`<div class="empty">${dot(tone)}<div><div class="empty-title">${title}</div><div class="muted">${text}</div></div></div>`;

export const card = (title: Html | string, body: Html, extra: Html | string = "") =>
  h`<section class="card"><header class="card-head"><h3>${title}</h3>${extra}</header>${body}</section>`;

const ICONS: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  board:
    '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
  agents: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  debt: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

/** Literal SVG paths from the table above; no data is ever interpolated into them. */
export const icon = (name: string) =>
  raw(
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`,
  );
