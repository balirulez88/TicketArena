import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

// One advisory lock key shared by every test process on the server. Template creation and
// cloning are serialized under it: CREATE DATABASE … TEMPLATE fails if anyone else is connected
// to the template, including a concurrent clone, and parallel turbo tasks would otherwise race.
const TEMPLATE_LOCK_KEY = 7_426_001;
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`test-infra: refusing unsafe database identifier "${name}"`);
  }
  return `"${name}"`;
}

export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function withTemplateLock<T>(adminUrl: string, work: (admin: pg.Client) => Promise<T>) {
  return withClient(adminUrl, async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    try {
      return await work(admin);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
    }
  });
}

interface Migration {
  readonly name: string;
  readonly sql: string;
}

async function readMigrations(migrationsDir: string): Promise<Migration[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(migrationsDir, name, "migration.sql"), "utf8"),
    })),
  );
}

async function databaseExists(admin: pg.Client, name: string): Promise<boolean> {
  const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return result.rowCount === 1;
}

/**
 * Returns the name of a database with every committed migration applied, creating it once.
 *
 * The name embeds a hash of the migrations, so a schema change produces a new template instead
 * of reusing a stale one. It is built under a temporary name and renamed only when complete, so
 * a crash mid-build can never leave a half-migrated template behind.
 */
export async function ensureTemplateDatabase(
  adminUrl: string,
  migrationsDir: string,
): Promise<string> {
  const migrations = await readMigrations(migrationsDir);
  const hash = createHash("sha256");
  for (const migration of migrations) {
    hash.update(migration.name).update("\0").update(migration.sql).update("\0");
  }
  const template = `ta_tpl_${hash.digest("hex").slice(0, 16)}`;

  await withTemplateLock(adminUrl, async (admin) => {
    if (await databaseExists(admin, template)) {
      return;
    }
    const building = `${template}_building`;
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(building)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(building)}`);
    await withClient(databaseUrl(adminUrl, building), async (client) => {
      for (const migration of migrations) {
        await client.query(migration.sql);
      }
    });
    await admin.query(
      `ALTER DATABASE ${quoteIdentifier(building)} RENAME TO ${quoteIdentifier(template)}`,
    );
  });
  return template;
}

/** Clones the template into a fresh, uniquely named database and returns its URL. */
export async function createDatabaseFromTemplate(
  adminUrl: string,
  template: string,
): Promise<string> {
  const name = `ta_t_${randomBytes(6).toString("hex")}`;
  await withTemplateLock(adminUrl, (admin) =>
    admin.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(template)}`),
  );
  return databaseUrl(adminUrl, name);
}

export async function dropDatabase(adminUrl: string, url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  await withClient(adminUrl, (admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`),
  );
}
