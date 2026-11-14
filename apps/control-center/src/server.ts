import { createServer, type Server } from "node:http";
import { clientScript } from "./assets";
import { renderPage } from "./render";
import type { DashboardState } from "./state";

export interface ServerDeps {
  /** Builds a fresh state from the artifacts; called once per request. */
  load(): Promise<DashboardState>;
  refreshSeconds: number;
}

// Scripts only from this origin (the one static asset below), no inline script, and the page may
// fetch only from this origin: the client re-reads `/` to refresh. Agent-written text is escaped
// on the server, and nothing on the page can submit, frame or redirect anywhere.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SCRIPT_PATH = "/assets/dashboard.js";

// Loopback binding is the only access control, and DNS rebinding defeats it: a page on another
// site can point its own name at 127.0.0.1 and read the state same-origin. The browser still sends
// that name as Host, so only the loopback names on the port actually served are answered.
function loopbackHost(host: string | undefined, port: number | undefined): boolean {
  return (
    port !== undefined &&
    ["127.0.0.1", "localhost", "[::1]"].some((name) => host?.toLowerCase() === `${name}:${port}`)
  );
}

// The state holds only plain data (no Map), so it serializes as-is.
const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * GET-only HTTP surface: `/` (HTML), `/api/state` (JSON) and the page's own script. There is no
 * route that changes anything, by design: the dashboard observes Ralph and never steers it.
 */
export function createDashboardServer(deps: ServerDeps): Server {
  return createServer((request, response) => {
    if (!loopbackHost(request.headers.host, request.socket.localPort)) {
      response.writeHead(421, { "content-type": "text/plain" });
      response.end("misdirected request: open the dashboard by its loopback address\n");
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
      response.end("read-only: only GET is supported\n");
      return;
    }
    if (path === SCRIPT_PATH) {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(clientScript());
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
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
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
