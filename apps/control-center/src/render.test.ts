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

  it("loads only its own external script: no inline script or event handler", async () => {
    const html = renderPage(
      await buildState(snapshot({ tickets: [ticket("13", "x", "ready-for-agent")] }), OPTIONS),
      { refreshSeconds: 30 },
    );
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script type="module" src="/assets/dashboard.js">']);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("javascript:");
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
    expect(html).toContain('<span class="tag tag-live" title="Describes the present">LIVE</span>');
    expect(html).toContain(">stale: claims active</span>");
    expect(html).toContain('Tickets <span class="tag tag-unavailable"');
    expect(html).toContain("<code>issues/ at main</code>: fatal: bad object");
    expect(html).toContain("Ralph is running");
    // Without script the page still refreshes itself; with script the client does it in place.
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="30"></noscript>');
    expect(html).toContain('data-refresh="30"');
  });

  it("says plainly when no run is active", async () => {
    const html = renderPage(
      await buildState(snapshot({ runs: [run("20261111-090000")] }), OPTIONS),
      { refreshSeconds: 30 },
    );
    expect(html).toContain("No run is active");
    expect(html).not.toContain("Ralph is running");
  });

  it("shows the status line verbatim beside a dashed calculated-eligibility badge", async () => {
    const state = await buildState(
      snapshot({
        tickets: [
          ticket("01", "base", "in-progress"),
          ticket("02", "after-base", "ready-for-agent", ["01"]),
          ticket("03", "odd", "doing"),
        ],
      }),
      OPTIONS,
    );
    const html = renderPage(state, { refreshSeconds: 0 });
    expect(html).toContain('data-column="unrecognized"');
    expect(html).toContain("unrecognized: doing");
    expect(html).toMatch(
      /class="badge calc t-warn"[^>]*><span class="calc-mark">calc<\/span>waiting on blockers/,
    );
    expect(html).toContain('data-card data-eligibility="waiting-blockers"');
    // The in-progress ticket gets no eligibility value: eligibility applies to ready-for-agent.
    expect(html).toContain('data-card data-eligibility="not-applicable"');
  });

  it("renders a pipeline whose planning stage is never claimed, and detail panels", async () => {
    const state = await buildState(
      snapshot({
        tickets: [ticket("13", "hold", "in-progress")],
        runs: [
          run("20261113-114500", {
            runJson: runJson("20261113-114500", "active"),
            sessionRecords: [sessionLine("2026-11-13T11:50:00Z", "13 green#1", "running")],
            lastActivity: NOW - MINUTE,
          }),
        ],
      }),
      OPTIONS,
    );
    const html = renderPage(state, { refreshSeconds: 0 });
    expect(html).toContain(
      'class="stage s-unknown" title="not recorded: Ralph writes no planning artifact"',
    );
    expect(html).toContain('class="stage s-active"');
    expect(html).toContain('id="d-ticket-13" data-detail-id="ticket-13"');
    for (const region of ["nav", "overview", "board", "agents", "debt", "runs", "details"]) {
      expect(html).toContain(`data-region="${region}"`);
    }
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
