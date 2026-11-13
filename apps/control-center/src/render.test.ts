import { describe, expect, it } from "vitest";
import { escapeHtml, renderPage } from "./render";
import { buildState } from "./state";
import { MINUTE, NOW, run, runJson, sessionLine, snapshot, ticket } from "./testing/fixtures";

const OPTIONS = { staleAfterMs: 15 * MINUTE, failureLimit: 25 };

describe("renderPage", () => {
  it("escapes agent-written text such as ticket titles and branch subjects", async () => {
    const evil = ticket("13", "x", "ready-for-agent");
    evil.text = evil.text.replace("# 13: x", "# 13: <script>alert(1)</script>");
    const state = await buildState(
      snapshot({
        tickets: [evil],
        branches: [
          {
            name: "rejected/13-x-1",
            sha: "a",
            date: "2026-11-13T10:00:00Z",
            subject: '"><img src=x>',
          },
        ],
      }),
      OPTIONS,
    );
    const html = renderPage(state, { refreshSeconds: 0 });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('"><img src=x>');
    expect(html).not.toContain("http-equiv");
  });

  it("labels live, stale and unavailable information distinctly", async () => {
    const state = await buildState(
      snapshot({
        tickets: null,
        register: null,
        gaps: [{ source: "issues/ at main", reason: "fatal: bad object" }],
        runs: [
          run("20261113-114500", {
            runJson: runJson("20261113-114500", "active"),
            sessionRecords: [sessionLine("2026-11-13T11:50:00Z", "13 green#1", "running")],
            lastActivity: NOW - MINUTE,
          }),
          run("20261112-090000", {
            runJson: runJson("20261112-090000", "active"),
            lastActivity: NOW - 600 * MINUTE,
          }),
        ],
      }),
      OPTIONS,
    );
    const html = renderPage(state, { refreshSeconds: 30 });
    expect(html).toContain('<span class="tag live" title="">LIVE</span>');
    expect(html).toContain('<span class="tag stale">stale: claims active</span>');
    expect(html).toContain('Tickets <span class="tag unavailable"');
    expect(html).toContain("<code>issues/ at main</code>: fatal: bad object");
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
