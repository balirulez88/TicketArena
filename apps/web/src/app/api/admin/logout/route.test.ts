import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { issueAdminCookieValue } from "@/server/identity/admin-session";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createTRPCContext } from "@/server/trpc";
import { POST } from "./route";

const SECRET = "s".repeat(32);
const createCaller = createCallerFactory(appRouter);

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.com/ticketarena?sslmode=require");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Applies Set-Cookie headers to a jar the way a browser does: `Max-Age=0` removes the cookie. */
function applySetCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
    if (expired) {
      jar.delete(name);
    } else {
      jar.set(name, pair.slice(separator + 1).trim());
    }
  }
}

async function contextFor(jar: Map<string, string>) {
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  return createTRPCContext({
    req: new Request("https://ticketarena.example/api/trpc", { headers: { cookie } }),
    resHeaders: new Headers(),
  });
}

describe("POST /api/admin/logout", () => {
  test("redirects with 303 to the login page, after which admin procedures are UNAUTHORIZED for that browser", async () => {
    const jar = new Map([["ta_admin", await issueAdminCookieValue(SECRET, new Date())]]);
    expect((await contextFor(jar)).isAdmin).toBe(true);

    const response = await POST(
      new Request("https://ticketarena.example/api/admin/logout", { method: "POST" }),
    );
    applySetCookies(jar, response);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://ticketarena.example/admin/login");
    await expect(createCaller(await contextFor(jar)).admin.snapshot()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
