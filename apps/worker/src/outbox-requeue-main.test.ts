import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createOutboxRelay,
  readOutboxHistory,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRequeueCommand } from "./outbox-requeue.js";

// The operator's `outbox:requeue` command (runbook: docs/messaging/failed-outbox-event.md), run as
// its own process against a row the real relay failed.
const database = setupTestDatabase();
const nats = setupTestNats();
const WORKER_DIR = resolve(__dirname, "..");

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const platformEnv = (): Record<string, string> => {
  const systemRoot = process.env["SystemRoot"];
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
};

function runRequeue(args: readonly string[]): Promise<Exit> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/outbox-requeue-main.ts", ...args],
      {
        cwd: WORKER_DIR,
        env: { ...platformEnv(), DATABASE_URL: database.url },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", fail);
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
}

async function failedBookingRow(): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.outboxEvent.create({
    data: {
      id,
      aggregateType: "order",
      aggregateId: crypto.randomUUID(),
      eventType: "unrouted.event",
      payload: {},
    },
  });
  const bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  try {
    await bus.ensureTopology();
    await createOutboxRelay({ bus, prisma, maxPermanentFailures: 1 }).tick();
  } finally {
    await bus.close();
  }
  return id;
}

describe("outbox:requeue", () => {
  it("requeues a FAILED row by service and id with the operator and reason, and exits zero", async () => {
    const id = await failedBookingRow();

    const exit = await runRequeue([
      "--service",
      "booking",
      "--id",
      id,
      "--operator",
      "alice",
      "--reason",
      "stream fixed",
    ]);

    expect(exit).toMatchObject({ code: 0, stderr: "" });
    expect(exit.stdout).toContain(`requeued booking outbox row ${id}`);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "PENDING", permanentFailures: 0 });
    expect((await readOutboxHistory(prisma, "booking", id)).at(-1)).toMatchObject({
      fromStatus: "FAILED",
      toStatus: "PENDING",
      operator: "alice",
      reason: "stream fixed",
    });
  }, 30_000);

  it("exits non-zero naming the row and its status when it is not FAILED", async () => {
    const id = crypto.randomUUID();
    await prisma.outboxEvent.create({
      data: {
        id,
        aggregateType: "order",
        aggregateId: crypto.randomUUID(),
        eventType: "order.placed",
        payload: {},
      },
    });

    const exit = await runRequeue([
      "--service",
      "booking",
      "--id",
      id,
      "--operator",
      "a",
      "--reason",
      "r",
    ]);

    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain(`booking outbox row ${id} is PENDING, not FAILED`);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  }, 30_000);
});

describe("parseRequeueCommand", () => {
  const valid = {
    argv: ["--service", "payment", "--id", crypto.randomUUID(), "--operator", "o", "--reason", "r"],
    env: { DATABASE_URL: "postgresql://u:p@localhost:5432/db" },
  };

  it("names every missing or invalid argument", () => {
    expect(() => parseRequeueCommand(["--service", "billing", "--id", "nope"], valid.env)).toThrow(
      /service[\s\S]*id[\s\S]*operator[\s\S]*reason/,
    );
  });

  it("names a missing DATABASE_URL", () => {
    expect(() => parseRequeueCommand(valid.argv, {})).toThrow(/DATABASE_URL/);
  });

  it("returns the validated command", () => {
    expect(parseRequeueCommand(valid.argv, valid.env)).toMatchObject({
      service: "payment",
      operator: "o",
      reason: "r",
      databaseUrl: valid.env.DATABASE_URL,
    });
  });
});
