import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "./route";

// The login behaviour itself is proven in `server/identity/admin-login.test.ts`; this file proves
// the route wires it to its configuration and to the shared admin limiter.

const PASSWORD = "correct horse battery";

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  // Nothing listens here: the limiter cannot be reached.
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://localhost:1");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function login(password: string): Request {
  const body = new FormData();
  body.set("password", password);
  return new Request("https://ticketarena.example/api/admin/login", { method: "POST", body });
}

describe("POST /api/admin/login", () => {
  test("takes the admin limiter first: with the limiter unreachable even the right password is refused", async () => {
    const response = await POST(login(PASSWORD));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ticketarena.example/admin/login?error=unavailable",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a missing ADMIN_PASSWORD fails naming the field", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");

    await expect(POST(login(PASSWORD))).rejects.toThrow(/ADMIN_PASSWORD/);
  });
});
