import { Writable } from "node:stream";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerLogger } from "./logger.js";

const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

/** The stdout boundary: every line the worker logger would write. */
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

/** What a Prisma or validation error looks like when it embeds the buyer's contact. */
class ContactConstraintError extends Error {
  override readonly name = "ContactConstraintError";
  readonly meta: { contactEmail: string; contactPhone: string };

  constructor(email: string, phone: string) {
    super(`Unique constraint failed on order contact (${email}, ${phone})`);
    this.meta = { contactEmail: email, contactPhone: phone };
  }
}

describe("worker log redaction", () => {
  it("TD-048: a handler error carrying a buyer's email and phone is logged with its name and the correlation ids but neither contact detail", async () => {
    const { stream, lines } = sink();
    const email = "td048.buyer@example.com";
    const phone = "+36 30 987 6543";
    const correlationId = crypto.randomUUID();
    const causationId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const subject = "ta.order.redaction1";
    const runner = await createConsumerRunner({
      bus,
      prisma,
      logger: createWorkerLogger(stream),
      consumer: "redaction-consumer-1",
      filterSubject: subject,
      handler: () => Promise.reject(new ContactConstraintError(email, phone)),
    });
    await bus.publish({
      subject,
      msgId: id,
      data: JSON.stringify({
        id,
        type: "order.placed",
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId,
        causationId,
        orderId,
        payload: { contact: { email, phone } },
      }),
    });

    await runner.pollOnce();

    const failure = lines.find((line) => line.includes("handler failed; retrying"));
    expect(failure).toBeDefined();
    const text = failure ?? "";
    expect(text).not.toContain(email);
    expect(text).not.toContain(phone);
    expect(JSON.parse(text)).toMatchObject({
      level: 50,
      messageId: id,
      correlationId,
      causationId,
      orderId,
      err: { type: "ContactConstraintError" },
    });
  });

  it("redacts contact fields in bindings and fields before the line is written", () => {
    const { stream, lines } = sink();

    createWorkerLogger(stream)
      .child({ recipient: "child.binding@example.com" })
      .info({ contact: { email: "field@example.com", phone: "0630 111 2222" } }, "sent");

    const text = lines.join("");
    expect(text).not.toContain("child.binding@example.com");
    expect(text).not.toContain("field@example.com");
    expect(text).not.toContain("0630 111 2222");
    expect(JSON.parse(text)).toMatchObject({ msg: "sent", contact: { email: "[Redacted]" } });
  });
});
