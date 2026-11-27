import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createPrismaClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, it } from "vitest";

// The real `db:seed` command, run as its own process: what it validates, that it awaits the seed,
// and that it disconnects (TD-011). A run takes about 3 s; a pool left open keeps the process
// alive for pg's 10 s idle timeout after the seed, so it cannot exit within EXIT_WITHIN_MS.
const database = setupTestDatabase();
const WORKER_DIR = resolve(__dirname, "..");
const EXIT_WITHIN_MS = 9_000;

interface Exit {
  readonly code: number | null;
  readonly stderr: string;
}

/** Runs the seed command with exactly `env` (nothing inherited) and waits for it to exit. */
function runSeed(env: Record<string, string>): Promise<Exit> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/seed-main.ts"], {
      cwd: WORKER_DIR,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`db:seed did not exit within ${EXIT_WITHIN_MS} ms:\n${stderr}`));
    }, EXIT_WITHIN_MS);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
}

// Node on Windows needs SystemRoot to load its crypto and networking; it carries no configuration.
const platformEnv = (): Record<string, string> => {
  const systemRoot = process.env["SystemRoot"];
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
};

describe("db:seed", () => {
  it("seeds the catalog into the database DATABASE_URL names and exits zero", async () => {
    const exit = await runSeed({ ...platformEnv(), DATABASE_URL: database.url });

    expect(exit).toEqual({ code: 0, stderr: "" });
    const prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      expect(await prisma.venue.count()).toBe(2);
      expect(await prisma.event.count()).toBe(3);
      expect(await prisma.seat.count()).toBe(116);
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  it("exits non-zero naming DATABASE_URL when it is missing", async () => {
    const exit = await runSeed(platformEnv());

    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain("DATABASE_URL");
  }, 30_000);
});
