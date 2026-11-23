import { createPrismaClient, type PrismaClient, type PrismaClientOptions } from "@ticketarena/db";
import { afterEach, beforeEach } from "vitest";

/** The per-file database from `setupTestDatabase()`; its URL is readable only in tests and hooks. */
export interface TestDatabaseUrl {
  readonly url: string;
}

/** Pool and transaction settings; the URL and the driver come from the test database. */
export type ClientOptions = Omit<PrismaClientOptions, "connectionString" | "driver">;

export interface TestClients {
  /** The running test's own client, opened before it and disconnected after it. */
  db(): PrismaClient;
  /** Opens one more client for the running test only, disconnected after it. */
  open(options?: ClientOptions): PrismaClient;
}

/**
 * Gives every test of the file its own clients. No client outlives its test, so a pool a test
 * saturates, a transaction it leaves open or a connection it breaks never reaches the next test.
 * Call it at the top of a file or `describe`, after `setupTestDatabase()`.
 */
export function testClients(database: TestDatabaseUrl): TestClients {
  const opened: PrismaClient[] = [];
  let current: PrismaClient | undefined;

  function open(options: ClientOptions = {}): PrismaClient {
    const client = createPrismaClient({ connectionString: database.url, driver: "pg", ...options });
    opened.push(client);
    return client;
  }

  beforeEach(() => {
    current = open();
  });

  afterEach(async () => {
    current = undefined;
    await Promise.all(opened.splice(0).map((client) => client.$disconnect()));
  });

  return {
    db() {
      if (current === undefined) {
        throw new Error("testClients: db() is available only inside a test or its beforeEach");
      }
      return current;
    },
    open,
  };
}

/**
 * Runs one-time work (seeding in `beforeAll`) on a client of its own, disconnected when it ends,
 * so no client is shared with the tests.
 */
export async function withClient<T>(
  database: TestDatabaseUrl,
  work: (db: PrismaClient) => Promise<T>,
  options: ClientOptions = {},
): Promise<T> {
  const db = createPrismaClient({ connectionString: database.url, driver: "pg", ...options });
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}
