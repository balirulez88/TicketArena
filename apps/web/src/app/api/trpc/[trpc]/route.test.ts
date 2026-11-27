import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("tRPC API route error logging", () => {
  test("an error whose message and stack carry a dot-separated phone and an email is logged by the route's onError with both masked", async () => {
    // stdout is the system boundary: pino writes through process.stdout once its write is replaced,
    // so the route's own logger (built when the module loads) is captured as it really runs.
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.com/ticketarena?sslmode=require");
    vi.resetModules();
    const { POST } = await import("./route");
    const email = "route.buyer@example.com";
    const phone = "555.010.9999";
    // An unknown path is a real procedure error from the real router: tRPC puts the path (here the
    // buyer's contact) in the error message, and so in its stack.
    const path = `${email}.${phone}`;

    const response = await POST(
      new Request(`https://ticketarena.example/api/trpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(404);
    const line = written.find((chunk) => chunk.includes("tRPC procedure failed"));
    expect(line).toBeDefined();
    const text = line ?? "";
    expect(text).not.toContain(email);
    expect(text).not.toContain(phone);
    expect(text).not.toContain("010");
    const logged = JSON.parse(text);
    expect(logged).toMatchObject({
      level: 50,
      name: "web",
      msg: "tRPC procedure failed",
      err: { code: "NOT_FOUND" },
    });
    expect(logged.err.message).toContain("[Redacted]");
    expect(logged.err.stack).toContain("[Redacted]");
  });
});
