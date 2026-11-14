import { describe, expect, it } from "vitest";
import { STYLE } from "./style";

// A bare `1fr` track has an automatic minimum: the widest unbreakable child (the nav row, a long
// path) widens the track, and with it the page. At 375px that pushed whole views off-screen.

const declarations = (property: string): string[] =>
  [...STYLE.matchAll(new RegExp(`${property}:([^;}]+)`, "g"))].map((match) => match[1] ?? "");

describe("stylesheet", () => {
  it("wraps every flexible grid track in minmax so content cannot widen the page", () => {
    const tracks = [...declarations("grid-template-columns"), ...declarations("grid-auto-columns")];
    expect(tracks.length).toBeGreaterThan(0);
    for (const value of tracks) {
      const bare = value.replace(/minmax\([^)]*\)/g, "");
      expect(bare, `grid track "${value}"`).not.toMatch(/\d*\.?\d+fr\b/);
    }
  });

  it("keeps a view's heading clear of the sticky top bar when the browser jumps to it", () => {
    // Without script every view is on the page and nav links are plain anchors.
    expect(STYLE).toMatch(/\.view\{scroll-margin-top:\d+px\}/);
  });

  it("keeps the ref, commit and read-only footer visible on narrow screens", () => {
    const phone = STYLE.slice(STYLE.indexOf("@media (max-width:900px)"));
    expect(phone).not.toMatch(/\.sidebar-foot\{display:none\}/);
  });

  it("keeps the single-column phone layout's track shrinkable", () => {
    const phone = STYLE.slice(STYLE.indexOf("@media (max-width:900px)"));
    expect(phone).toMatch(/\.app\{grid-template-columns:minmax\(0,1fr\)\}/);
  });
});
