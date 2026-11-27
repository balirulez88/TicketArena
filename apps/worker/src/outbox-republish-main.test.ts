import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { readOutboxHistory } from "@ticketarena/messaging";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRepublishCommand } from "./outbox-republish.js";

// The operator's `outbox:republish` command (runbook: docs/messaging/consumer-recovery.md), run as
// its own process against a real database.
const database = setupTestDatabase();
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

function runRepublish(args: readonly string[]): Promise<Exit> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/outbox-republish-main.ts", ...args],
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

const PUBLISHED_AT = new Date("2027-04-01T10:00:00.000Z");

describe("outbox:republish", () => {
  it("moves the service's PUBLISHED rows in the range to PENDING with the operator and reason, and exits zero", async () => {
    const id = crypto.randomUUID();
    await prisma.notificationOutboxEvent.create({
      data: {
        id,
        aggregateType: "notification",
        aggregateId: crypto.randomUUID(),
        eventType: "notification.sent",
        payload: {},
        status: "PUBLISHED",
        publishedAt: PUBLISHED_AT,
      },
    });

    const exit = await runRepublish([
      "--service",
      "notification",
      "--from",
      "2027-04-01T00:00:00Z",
      "--to",
      "2027-04-02T00:00:00Z",
      "--operator",
      "alice",
      "--reason",
      "stream lost",
    ]);

    expect(exit).toMatchObject({ code: 0, stderr: "" });
    expect(exit.stdout).toContain("re-published 1 notification outbox row(s)");
    expect((await prisma.notificationOutboxEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
      "PENDING",
    );
    expect((await readOutboxHistory(prisma, "notification", id)).at(-1)).toMatchObject({
      fromStatus: "PUBLISHED",
      toStatus: "PENDING",
      operator: "alice",
      reason: "stream lost",
    });
  }, 30_000);

  it("exits non-zero for an empty range, changing nothing", async () => {
    const exit = await runRepublish([
      "--service",
      "booking",
      "--from",
      "2027-04-02T00:00:00Z",
      "--to",
      "2027-04-01T00:00:00Z",
      "--operator",
      "a",
      "--reason",
      "r",
    ]);

    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain("is empty");
  }, 30_000);
});

describe("parseRepublishCommand", () => {
  const env = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
  const argv = [
    "--service",
    "payment",
    "--from",
    "2027-04-01T00:00:00Z",
    "--to",
    "2027-04-02T00:00:00Z",
    "--operator",
    "o",
    "--reason",
    "r",
  ];

  it("names every missing or invalid argument", () => {
    expect(() =>
      parseRepublishCommand(["--service", "billing", "--from", "yesterday"], env),
    ).toThrow(/service[\s\S]*from[\s\S]*to[\s\S]*operator[\s\S]*reason/);
  });

  it("names a missing DATABASE_URL", () => {
    expect(() => parseRepublishCommand(argv, {})).toThrow(/DATABASE_URL/);
  });

  it("returns the validated command with the range as dates", () => {
    expect(parseRepublishCommand(argv, env)).toEqual({
      databaseUrl: env.DATABASE_URL,
      service: "payment",
      publishedFrom: new Date("2027-04-01T00:00:00Z"),
      publishedTo: new Date("2027-04-02T00:00:00Z"),
      operator: "o",
      reason: "r",
    });
  });
});
