// Browser script for the dashboard. It only navigates, filters, opens details and refreshes: every
// value it shows comes from the server-rendered (and server-escaped) page. It never builds markup
// from strings and never calls anything but `GET` on its own origin, so the CSP can stay at
// `script-src 'self'; connect-src 'self'`.
//
// This file must stay self-contained (no runtime imports): the server serves it after a
// type-only transpile, without a bundler. The pure helpers are exported for the tests.

export const VIEWS = ["overview", "board", "agents", "debt", "runs"] as const;
export type View = (typeof VIEWS)[number];

/** `#board` → `board`; anything unknown (including a detail anchor) falls back to the overview. */
export function viewFromHash(hash: string): View {
  const name = hash.replace(/^#/, "");
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : "overview";
}

export interface BoardFilter {
  query: string;
  /** `open`: every column except done; `all`; or one status column key. */
  status: string;
  /** `any`, or one calculated eligibility value. */
  eligibility: string;
}

export interface CardData {
  status: string;
  eligibility: string;
  search: string;
}

export function columnVisible(key: string, filter: BoardFilter): boolean {
  if (filter.status === "all") {
    return true;
  }
  if (filter.status === "open") {
    return key !== "done";
  }
  return key === filter.status;
}

/** Search matches every whitespace-separated term, case-insensitively, against the card text. */
export function cardMatches(card: CardData, filter: BoardFilter): boolean {
  if (!columnVisible(card.status, filter)) {
    return false;
  }
  if (filter.eligibility !== "any" && card.eligibility !== filter.eligibility) {
    return false;
  }
  const haystack = card.search.toLowerCase();
  return filter.query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => haystack.includes(term));
}

export interface RefreshContext {
  intervalSeconds: number;
  paused: boolean;
  hidden: boolean;
  /** The reader has text selected; swapping the DOM would drop the selection. */
  selecting: boolean;
}

export function shouldRefresh(context: RefreshContext): boolean {
  return context.intervalSeconds > 0 && !(context.paused || context.hidden || context.selecting);
}

export function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

// ---------------------------------------------------------------------------------------------
// DOM wiring: thin, each piece bound to the markup render.ts produces.

function all<T extends Element>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/**
 * Shows the view the hash names and marks its nav link current, without scrolling. A refresh
 * calls this too: the server's nav markup never marks a link current.
 */
export function markView(doc: Document, hash: string): void {
  const view = viewFromHash(hash);
  for (const section of all<HTMLElement>(doc, "[data-view]")) {
    section.hidden = section.dataset["view"] !== view;
  }
  for (const link of all<HTMLElement>(doc, "[data-nav]")) {
    if (link.dataset["nav"] === view) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

/**
 * Shows the view the hash names and scrolls to the top. Following the `#view` anchor instead
 * would put the section's heading under the sticky top bar.
 */
export function switchView(doc: Document, win: Window, hash: string): void {
  markView(doc, hash);
  win.scrollTo(0, 0);
}

// Nav and in-page view links (`#board`, `#debt`) switch views here rather than letting the browser
// jump to the anchor; the history entry keeps Back and a reload on the same view.
function wireNavigation(doc: Document, win: Window): void {
  doc.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a[href^="#"]');
    const hash = link?.getAttribute("href") ?? "";
    if (!link || link.hasAttribute("data-detail") || viewFromHash(hash) !== hash.slice(1)) {
      return;
    }
    event.preventDefault();
    if (win.location.hash !== hash) {
      win.history.pushState(null, "", hash);
    }
    switchView(doc, win, hash);
  });
  win.addEventListener("hashchange", () => switchView(doc, win, win.location.hash));
}

const FILTER_FIELDS = ["board-search", "board-status", "board-eligibility"] as const;

function readFilter(doc: Document): BoardFilter {
  const value = (id: string, fallback: string) =>
    (doc.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? fallback;
  return {
    query: value("board-search", ""),
    status: value("board-status", "open"),
    eligibility: value("board-eligibility", "any"),
  };
}

function applyFilters(doc: Document): void {
  const filter = readFilter(doc);
  for (const column of all<HTMLElement>(doc, "[data-column]")) {
    const status = column.dataset["column"] ?? "";
    column.hidden = !columnVisible(status, filter);
    let shown = 0;
    for (const card of all<HTMLElement>(column, "[data-card]")) {
      const eligibility = card.dataset["eligibility"] ?? "";
      const search = card.dataset["search"] ?? "";
      card.hidden = !cardMatches({ status, eligibility, search }, filter);
      shown += card.hidden ? 0 : 1;
    }
    const count = column.querySelector<HTMLElement>("[data-shown]");
    if (count) {
      count.textContent = String(shown);
    }
    column.querySelector<HTMLElement>("[data-empty]")?.toggleAttribute("hidden", shown > 0);
  }
}

/** The detail drawer. `show` returns whether a detail with that id exists on the page. */
export function createDrawer(doc: Document) {
  const drawer = doc.getElementById("drawer");
  let current: string | null = null;
  let returnFocus: HTMLElement | null = null;
  const show = (id: string | null): boolean => {
    let found = false;
    for (const detail of all<HTMLElement>(doc, "[data-detail-id]")) {
      const match = detail.dataset["detailId"] === id;
      detail.classList.toggle("open", match);
      found ||= match;
    }
    drawer?.classList.toggle("open", found);
    current = found ? id : null;
    return found;
  };
  return {
    current: () => current,
    show,
    open(opener: HTMLElement, id: string) {
      returnFocus = opener;
      if (show(id)) {
        // The visible ✕, not the first [data-close]: that is the full-screen scrim, which has
        // no visible focus ring and would leave keyboard users nowhere.
        drawer?.querySelector<HTMLElement>(".close[data-close]")?.focus();
      }
    },
    close() {
      show(null);
      returnFocus?.focus();
      returnFocus = null;
    },
  };
}
type Drawer = ReturnType<typeof createDrawer>;

function wireDrawer(doc: Document, drawer: Drawer): void {
  doc.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const opener = target?.closest<HTMLElement>("[data-detail]");
    const id = opener?.dataset["detail"];
    if (opener && id) {
      event.preventDefault();
      drawer.open(opener, id);
    } else if (target?.closest("[data-close]")) {
      event.preventDefault();
      drawer.close();
    }
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer.current() !== null) {
      drawer.close();
    }
  });
}

/**
 * Replaces each `[data-region]` with its fresh copy, keeping what the reader did: the open
 * `<details>`, the board filters (they live outside the regions) and the open drawer entry.
 */
function swapRegions(doc: Document, next: Document, drawer: Drawer, hash: string): void {
  const open = new Set(
    all<HTMLDetailsElement>(doc, "details[data-key]")
      .filter((details) => details.open)
      .map((details) => details.dataset["key"]),
  );
  const fresh = new Map(
    all<HTMLElement>(next, "[data-region]").map((region) => [region.dataset["region"], region]),
  );
  for (const region of all<HTMLElement>(doc, "[data-region]")) {
    const replacement = fresh.get(region.dataset["region"]);
    if (replacement) {
      region.replaceChildren(...[...replacement.childNodes].map((n) => doc.importNode(n, true)));
    }
  }
  for (const details of all<HTMLDetailsElement>(doc, "details[data-key]")) {
    details.open = open.has(details.dataset["key"]);
  }
  markView(doc, hash);
  applyFilters(doc);
  drawer.show(drawer.current());
}

function wireRefresh(doc: Document, win: Window, drawer: Drawer): void {
  const intervalSeconds = Number(doc.body.dataset["refresh"] ?? "0") || 0;
  const stamp = doc.getElementById("refresh-stamp");
  const toggle = doc.getElementById("refresh-toggle");
  const status = { paused: false, failed: false, loadedAt: Date.now() };

  const updateStamp = () => {
    const age = ageText(Date.now() - status.loadedAt);
    const text = status.paused ? `paused · updated ${age}` : `updated ${age}`;
    if (stamp) {
      stamp.textContent = status.failed ? `refresh failed · data from ${age}` : text;
      stamp.classList.toggle("bad", status.failed);
    }
  };

  const refresh = async (force: boolean) => {
    const context: RefreshContext = {
      intervalSeconds,
      paused: status.paused,
      hidden: doc.hidden,
      selecting: (win.getSelection()?.toString() ?? "") !== "",
    };
    if (!(force || shouldRefresh(context))) {
      return;
    }
    try {
      const response = await win.fetch(win.location.pathname, {
        cache: "no-store",
        headers: { accept: "text/html" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const next = new DOMParser().parseFromString(await response.text(), "text/html");
      swapRegions(doc, next, drawer, win.location.hash);
      status.loadedAt = Date.now();
      status.failed = false;
    } catch {
      status.failed = true;
    }
    updateStamp();
  };

  toggle?.addEventListener("click", () => {
    status.paused = !status.paused;
    toggle.setAttribute("aria-pressed", String(status.paused));
    toggle.textContent = status.paused ? "Resume" : "Pause";
    updateStamp();
  });
  doc.getElementById("refresh-now")?.addEventListener("click", () => {
    void refresh(true);
  });
  doc.addEventListener("visibilitychange", () => {
    if (!doc.hidden && Date.now() - status.loadedAt > intervalSeconds * 1000) {
      void refresh(false);
    }
  });
  updateStamp();
  win.setInterval(updateStamp, 5000);
  if (intervalSeconds > 0) {
    win.setInterval(() => void refresh(false), intervalSeconds * 1000);
  } else {
    toggle?.setAttribute("hidden", "");
  }
}

function boot(doc: Document): void {
  const win = doc.defaultView;
  if (win === null) {
    return;
  }
  doc.documentElement.classList.add("js");
  const drawer = createDrawer(doc);
  wireNavigation(doc, win);
  switchView(doc, win, win.location.hash);
  for (const id of FILTER_FIELDS) {
    doc.getElementById(id)?.addEventListener("input", () => applyFilters(doc));
  }
  applyFilters(doc);
  wireDrawer(doc, drawer);
  wireRefresh(doc, win, drawer);
}

if (typeof document !== "undefined") {
  boot(document);
}
