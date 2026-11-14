import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "./server";
import { buildState, type DashboardState } from "./state";
import { snapshot, ticket } from "./testing/fixtures";

let close: (() => Promise<void>) | undefined;

async function serve(load: () => Promise<DashboardState>): Promise<string> {
  const server = createDashboardServer({ load, refreshSeconds: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

const state = () =>
  buildState(snapshot({ tickets: [ticket("13", "release-hold", "ready-for-agent")] }), {
    staleAfterMs: 60_000,
    failureLimit: 25,
  });

describe("dashboard server", () => {
  it("serves the page and the JSON state", async () => {
    const base = await serve(state);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("release hold");

    const api = await fetch(`${base}/api/state`);
    const body = (await api.json()) as { tickets: { number: string; status: string }[] };
    expect(body.tickets.map((t) => [t.number, t.status])).toEqual([["13", "ready-for-agent"]]);
  });

  it("serves the page under a CSP that allows only its own script and same-origin fetches", async () => {
    const base = await serve(state);
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("unsafe-eval");

    const script = await fetch(`${base}/assets/dashboard.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    const source = await script.text();
    // Transpiled: TypeScript syntax is gone, the behaviour is there.
    expect(source).toContain("export function viewFromHash(hash)");
    expect(source).not.toMatch(/: BoardFilter\b/);
    expect((await fetch(`${base}/assets/other.js`)).status).toBe(404);
  });

  it("refuses every method that could change something, and unknown paths", async () => {
    const base = await serve(state);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/api/state", "/assets/dashboard.js"]) {
        const response = await fetch(`${base}${path}`, { method });
        expect(response.status).toBe(405);
      }
    }
    expect((await fetch(`${base}/api/run`)).status).toBe(404);
  });

  it("answers 500 with the reason when the artifacts cannot be read", async () => {
    const base = await serve(() => Promise.reject(new Error("disk gone")));
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("disk gone");
  });

  it("refuses a request whose Host is not this loopback address (DNS rebinding)", async () => {
    const base = await serve(state);
    const port = new URL(base).port;
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${base}/api/state`, { headers: { host } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1:1", "localhost"]) {
      expect(await statusFor(host)).toBe(421);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect(await statusFor(host)).toBe(200);
    }
  });
});
