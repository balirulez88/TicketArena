import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerEnv } from "./env.js";

// The Fly.io and CI files are not executed by any test, so these checks pin the properties the
// deployment relies on (ADR 0013) and keep the files consistent with each other and with the
// worker's own configuration boundary.

const repoRoot = join(import.meta.dirname, "../../..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** The flat `key = value` pairs of each TOML table; enough for the plain fly.toml files here. */
function tomlTables(source: string): Map<string, Record<string, string>> {
  const tables = new Map<string, Record<string, string>>([["", {}]]);
  let current = "";
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1].trim();
      tables.set(current, tables.get(current) ?? {});
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    const table = tables.get(current);
    if (pair?.[1] !== undefined && pair[2] !== undefined && table !== undefined) {
      table[pair[1]] = pair[2].replace(/^"(.*)"$/, "$1");
    }
  }
  return tables;
}

function table(tables: Map<string, Record<string, string>>, name: string): Record<string, string> {
  const found = tables.get(name);
  if (found === undefined) {
    throw new Error(`fly.toml has no [${name}] table`);
  }
  return found;
}

const natsToml = tomlTables(read("infra/fly/nats/fly.toml"));
const workerToml = tomlTables(read("infra/fly/worker/fly.toml"));
const natsConf = read("infra/fly/nats/nats.conf");

describe("NATS on Fly.io", () => {
  it("fsyncs every JetStream write", () => {
    expect(natsConf).toMatch(/^\s*sync_interval:\s*always\s*$/m);
  });

  it("keeps the JetStream store on the mounted Fly volume", () => {
    const mount = table(natsToml, "mounts");
    const storeDir = /^\s*store_dir:\s*"?([^"\s]+)"?\s*$/m.exec(natsConf)?.[1];

    expect(mount["source"]).toMatch(/\S/);
    expect(storeDir?.startsWith(`${mount["destination"]}/`)).toBe(true);
  });

  it("listens on the IPv6 private network and has no public service", () => {
    expect(natsConf).toMatch(/^\s*listen:\s*"\[::\]:4222"\s*$/m);
    expect([...natsToml.keys()].filter((name) => /services?$/.test(name))).toEqual([]);
  });

  it("requires a client token read from the NATS_TOKEN secret, never written in the file", () => {
    expect(natsConf).toMatch(/^\s*authorization\s*\{\s*token:\s*\$NATS_TOKEN\s*\}\s*$/m);
    expect(natsToml.get("env") ?? {}).not.toHaveProperty("NATS_TOKEN");
  });
});

describe("the worker on Fly.io", () => {
  it("has no public service", () => {
    expect([...workerToml.keys()].filter((name) => /services?$/.test(name))).toEqual([]);
  });

  it("reaches NATS over the private network by the NATS app's name", () => {
    const natsApp = table(natsToml, "")["app"];

    expect(table(workerToml, "env")["NATS_URL"]).toBe(`nats://${natsApp}.internal:4222`);
  });

  it("is health-checked on /health at the port it listens on", () => {
    const env = table(workerToml, "env");
    const check = table(workerToml, "checks.health");

    expect(check["type"]).toBe("http");
    expect(check["path"]).toBe("/health");
    expect(check["port"]).toBe(env["PORT"]);
  });

  it("its [env] plus the documented secrets pass the worker's configuration boundary", () => {
    const secrets = {
      DATABASE_URL:
        "postgresql://app:secret@ep-quiet-bird-a1b2c3.eu-central-1.aws.neon.tech/ticketarena?sslmode=require",
      REDIS_URL: "rediss://default:secret@example.upstash.io:6379",
      NATS_TOKEN: "n".repeat(64),
    };

    const env = parseWorkerEnv({ ...table(workerToml, "env"), ...secrets });

    expect(env.NATS_URL).toBe(table(workerToml, "env")["NATS_URL"]);
    expect(Object.keys(table(workerToml, "env")).filter((key) => key in secrets)).toEqual([]);
  });
});

describe("the deploy workflow", () => {
  const workflow = read(".github/workflows/deploy.yml");

  /** The lines of one top-level job, up to the next job. */
  function job(name: string): string {
    const start = workflow.search(new RegExp(`^  ${name}:\\s*$`, "m"));
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("applies migrations with prisma migrate deploy on the direct Neon URL", () => {
    const migrate = job("migrate");

    expect(migrate).toContain("prisma migrate deploy");
    expect(migrate).toMatch(/^\s+DATABASE_URL: \$\{\{ secrets\.DATABASE_URL_UNPOOLED \}\}\s*$/m);
  });

  it("deploys the web app and the worker only after the migrations succeeded", () => {
    for (const name of ["web", "worker"]) {
      expect(job(name)).toMatch(/^ {4}needs: \[[^\]]*\bmigrate\b[^\]]*\]\s*$/m);
    }
  });

  it("the gate resolves the commit with deploy-target and every target is off unless it deploys", () => {
    const gate = job("gate");

    expect(gate).toContain("run: node apps/worker/src/deploy/deploy-target.ts");
    expect(gate).toContain(`sha: \${{ steps.target.outputs.sha }}`);
    for (const target of ["migrate", "web", "worker"]) {
      expect(gate).toContain(
        `${target}: \${{ steps.target.outputs.deploy == 'true' && steps.check.outputs.${target} }}`,
      );
    }
    expect(workflow).toMatch(/^ {2}actions: read\s*$/m);
  });

  it("every job checks out the one commit the gate pinned, never the triggering run's head", () => {
    for (const name of ["migrate", "web", "worker"]) {
      const refs = job(name).match(/^\s+ref: .*$/gm) ?? [];

      expect(refs.map((ref) => ref.trim())).toEqual([`ref: \${{ needs.gate.outputs.sha }}`]);
    }
  });

  it.each([
    ["migrate", "prisma migrate deploy"],
    ["web", "vercel deploy"],
    ["worker", "flyctl deploy"],
  ])("%s re-checks the pinned commit itself before it changes production", (name, action) => {
    // A partial re-run reuses the gate's old outputs, so the gate alone cannot stop a stale sha.
    const lines = job(name);
    const recheck = lines.indexOf("EVENT_NAME: recheck");

    expect(recheck).toBeGreaterThanOrEqual(0);
    expect(lines.slice(recheck)).toMatch(
      /^EVENT_NAME: recheck\n\s+CANDIDATE_SHA: \$\{\{ needs\.gate\.outputs\.sha \}\}\n\s+run: node apps\/worker\/src\/deploy\/deploy-target\.ts\n/,
    );
    expect(lines.indexOf("actions/setup-node")).toBeLessThan(recheck);
    expect(lines.indexOf(action)).toBeGreaterThan(recheck);
  });
});
