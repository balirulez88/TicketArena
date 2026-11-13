import { createServer, type Server } from "node:http";
import { renderPage } from "./render";
import type { DashboardState } from "./state";

export interface ServerDeps {
  /** Builds a fresh state from the artifacts; called once per request. */
  load(): Promise<DashboardState>;
  refreshSeconds: number;
}

// The state holds only plain data (no Map), so it serializes as-is.
const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * GET-only HTTP surface: `/` (HTML) and `/api/state` (JSON). There is no route that changes
 * anything, by design: the dashboard observes Ralph and never steers it.
 */
export function createDashboardServer(deps: ServerDeps): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
      response.end("read-only: only GET is supported\n");
      return;
    }
    if (path !== "/" && path !== "/api/state") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    deps.load().then(
      (state) => {
        const html = path === "/";
        response.writeHead(200, {
          "content-type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        response.end(html ? renderPage(state, deps) : json(state));
      },
      (error: unknown) => {
        console.error("control-center: could not build the state", error);
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(
          `could not read the artifacts: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  });
}
