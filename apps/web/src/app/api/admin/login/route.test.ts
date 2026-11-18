import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proxy } from "@/proxy";
import { POST } from "./route";

const PASSWORD = "correct horse battery";

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function login(password?: string): Request {
  const body = new FormData();
  if (password !== undefined) {
    body.set("password", password);
  }
  return new Request("https://ticketarena.example/api/admin/login", { method: "POST", body });
}

describe("POST /api/admin/login", () => {
  test("the admin password sets a signed, httpOnly, Secure, SameSite=Strict ta_admin cookie and redirects to /admin", async () => {
    const response = await POST(login(PASSWORD));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://ticketarena.example/admin");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^ta_admin=\d+\.[0-9a-f]{64};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).toMatch(/Max-Age=28800/);
  });

  test("the issued cookie opens /admin through the proxy", async () => {
    const response = await POST(login(PASSWORD));
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const page = await proxy(
      new NextRequest("https://ticketarena.example/admin", { headers: { cookie } }),
    );

    expect(page.headers.get("location")).toBeNull();
  });

  test.each([
    ["a wrong password", "wrong password!"],
    ["no password", undefined],
  ])("%s sets no cookie and returns to the login page with an error", async (_case, password) => {
    const response = await POST(login(password));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ticketarena.example/admin/login?error=invalid",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a missing ADMIN_PASSWORD fails naming the field", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");

    await expect(POST(login(PASSWORD))).rejects.toThrow(/ADMIN_PASSWORD/);
  });
});
