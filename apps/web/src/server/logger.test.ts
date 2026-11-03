import { Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createWebLogger } from "./logger";

describe("web logger", () => {
  test("writes JSON lines carrying the ids bound on a child", () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    });
    const correlationId = crypto.randomUUID();

    createWebLogger(sink).child({ correlationId, causationId: null }).info({ holdId: "h" }, "hi");

    expect(JSON.parse(chunks.join(""))).toMatchObject({
      name: "web",
      msg: "hi",
      correlationId,
      causationId: null,
      holdId: "h",
    });
  });

  test("createTRPCContext injects a logger from the app boundary", async () => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.com/ticketarena?sslmode=require");
    const { createTRPCContext } = await import("./trpc");

    const ctx = await createTRPCContext({ req: new Request("https://ticketarena.example/") });

    expect(typeof ctx.logger.child).toBe("function");
    vi.unstubAllEnvs();
  });
});
