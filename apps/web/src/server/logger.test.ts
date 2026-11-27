import { Writable } from "node:stream";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { describe, expect, test, vi } from "vitest";
import { createWebLogger, logProcedureError } from "./logger";

function sink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { stream, lines };
}

/** A failure that embeds the buyer's contact, as a Prisma or validation error can. */
class ContactConstraintError extends Error {
  override readonly name = "ContactConstraintError";
  readonly meta: { contactEmail: string; contactPhone: string };

  constructor(email: string, phone: string) {
    super(`Unique constraint failed on order contact (${email}, ${phone})`);
    this.meta = { contactEmail: email, contactPhone: phone };
  }
}

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

    const ctx = await createTRPCContext({
      req: new Request("https://ticketarena.example/"),
      resHeaders: new Headers(),
    });

    expect(typeof ctx.logger.child).toBe("function");
    vi.unstubAllEnvs();
  });

  test("a tRPC procedure error carrying a buyer's email and phone is logged with its name, path and correlation ids but neither contact detail", async () => {
    const { stream, lines } = sink();
    const email = "web.buyer@example.com";
    const phone = "+1 (555) 010-9999";
    const correlationId = crypto.randomUUID();
    const t = initTRPC.create();
    const router = t.router({
      placeOrder: t.procedure.mutation(() => {
        throw new ContactConstraintError(email, phone);
      }),
    });

    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("https://ticketarena.example/api/trpc/placeOrder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      router,
      createContext: () => ({}),
      onError: logProcedureError(createWebLogger(stream).child({ correlationId })),
    });

    expect(response.status).toBe(500);
    const text = lines.join("");
    expect(text).not.toContain(email);
    expect(text).not.toContain(phone);
    expect(text).toContain("ContactConstraintError");
    expect(JSON.parse(text)).toMatchObject({
      level: 50,
      name: "web",
      correlationId,
      path: "placeOrder",
      msg: "tRPC procedure failed",
      err: { code: "INTERNAL_SERVER_ERROR" },
    });
  });
});
