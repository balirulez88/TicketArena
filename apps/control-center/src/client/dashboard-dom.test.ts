import { describe, expect, it } from "vitest";
import { createDrawer, markView, switchView } from "./dashboard";

// The browser is this script's system boundary, and the app has no DOM library, so these tests
// use a minimal stand-in: a flat list of elements in document order, matched by simple selectors
// (`.class`, `[attribute]` and combinations), so they do not depend on which selector the script
// happens to use.

interface FakeElement {
  hidden: boolean;
  dataset: Record<string, string>;
  classes: Set<string>;
  attributes: Map<string, string>;
  classList: { toggle(name: string, force?: boolean): boolean };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function matches(element: FakeElement, selector: string): boolean {
  const tokens = selector.match(/\.[\w-]+|\[[\w-]+\]/g) ?? [];
  if (tokens.join("") !== selector) {
    throw new Error(`fake DOM does not support the selector "${selector}"`);
  }
  return tokens.every((token) =>
    token.startsWith(".")
      ? element.classes.has(token.slice(1))
      : element.attributes.has(token.slice(1, -1)),
  );
}

function fakeDom() {
  const focus: { current: FakeElement | null } = { current: null };
  const elements: FakeElement[] = [];
  const query = (scope: FakeElement[]) => ({
    querySelector: (selector: string) => scope.find((e) => matches(e, selector)) ?? null,
    querySelectorAll: (selector: string) => scope.filter((e) => matches(e, selector)),
  });
  const element = (classes: string[], attributes: Record<string, string> = {}): FakeElement => {
    const children: FakeElement[] = [];
    const self: FakeElement = {
      hidden: false,
      dataset: {},
      classes: new Set(classes),
      attributes: new Map(),
      classList: {
        toggle: (name, force) => {
          const on = force ?? !self.classes.has(name);
          if (on) {
            self.classes.add(name);
          } else {
            self.classes.delete(name);
          }
          return on;
        },
      },
      setAttribute: (name, value) => {
        self.attributes.set(name, value);
        if (name.startsWith("data-")) {
          self.dataset[camel(name.slice(5))] = value;
        }
      },
      removeAttribute: (name) => {
        self.attributes.delete(name);
      },
      getAttribute: (name) => self.attributes.get(name) ?? null,
      focus: () => {
        focus.current = self;
      },
      ...query(children),
    };
    for (const [name, value] of Object.entries(attributes)) {
      self.setAttribute(name, value);
    }
    elements.push(self);
    return Object.assign(self, { children });
  };
  const inside = (parent: FakeElement, ...kids: FakeElement[]) => {
    (parent as FakeElement & { children: FakeElement[] }).children.push(...kids);
    return parent;
  };
  const doc = {
    getElementById: (id: string) => elements.find((e) => e.getAttribute("id") === id) ?? null,
    ...query(elements),
  };
  return { doc: doc as unknown as Document, element, inside, focus };
}

describe("detail drawer", () => {
  it("moves focus to the visible close button, not the full-screen scrim", () => {
    const dom = fakeDom();
    const scrim = dom.element(["scrim"], { "data-close": "" });
    const close = dom.element(["close"], { "data-close": "" });
    dom.inside(dom.element(["drawer"], { id: "drawer" }), scrim, close);
    dom.element(["detail"], { "data-detail-id": "ticket-13" });
    const opener = dom.element(["tcard"], { "data-detail": "ticket-13" });

    const drawer = createDrawer(dom.doc);
    drawer.open(opener as unknown as HTMLElement, "ticket-13");
    expect(dom.focus.current).toBe(close);

    drawer.close();
    expect(dom.focus.current).toBe(opener);
  });
});

describe("view switching", () => {
  const page = () => {
    const dom = fakeDom();
    const views = ["overview", "board", "runs"].map((view) =>
      dom.element(["view"], { "data-view": view }),
    );
    const links = ["overview", "board", "runs"].map((view) =>
      dom.element([], { "data-nav": view }),
    );
    const scrolls: [number, number][] = [];
    const win = {
      scrollTo: (x: number, y: number) => {
        scrolls.push([x, y]);
      },
    } as unknown as Window;
    return { dom, views, links, win, scrolls };
  };

  it("shows only the chosen view and marks its nav link current", () => {
    const { dom, views, links, win } = page();
    switchView(dom.doc, win, "#board");
    expect(views.map((v) => v.hidden)).toEqual([true, false, true]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("re-marks the current view without scrolling, for nav links a refresh just replaced", () => {
    const { dom, views, links, win, scrolls } = page();
    switchView(dom.doc, win, "#board");
    // The refreshed nav markup comes from the server, which never marks a link current.
    for (const link of links) {
      link.removeAttribute("aria-current");
    }
    markView(dom.doc, "#board");
    expect(views.map((v) => v.hidden)).toEqual([true, false, true]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(scrolls).toEqual([[0, 0]]);
  });

  it("scrolls to the top so the sticky header never covers the view's heading", () => {
    const { dom, win, scrolls } = page();
    switchView(dom.doc, win, "#runs");
    switchView(dom.doc, win, "#runs");
    expect(scrolls).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});
