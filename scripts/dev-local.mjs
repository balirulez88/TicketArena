// `pnpm dev:local`: the whole system on this machine, in one command.
// Starts the compose services (Postgres, Redis, its Upstash-compatible REST proxy, NATS
// JetStream), migrates and seeds the local database, then runs the web app and the worker side by
// side until Ctrl+C. The worker matters: without it nobody admits from the waiting room, relays
// the outbox, takes payments or sends notifications, so `pnpm dev` alone cannot complete a purchase.
//
// Configuration lives in `.env.dev` (git-ignored). The first run writes it with values that match
// docker-compose.yml and freshly generated secrets; edit it freely afterwards. Its values win over
// `apps/web/.env.local`, so the web app and the worker always talk to the same services.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.dev");
const isWindows = process.platform === "win32";

function say(message) {
  process.stdout.write(`${message}\n`);
}

function secret(bytes) {
  return randomBytes(bytes).toString("hex");
}

function writeDefaultEnv() {
  const lines = [
    "# Written by `pnpm dev:local` for the docker-compose services; git-ignored, edit freely.",
    'DATABASE_URL="postgresql://ticketarena:ticketarena@localhost:55432/ticketarena"',
    'DATABASE_DRIVER="pg"',
    'REDIS_URL="redis://localhost:6379"',
    'UPSTASH_REDIS_REST_URL="http://localhost:8079"',
    'UPSTASH_REDIS_REST_TOKEN="ticketarena"',
    'NATS_URL="nats://localhost:4222"',
    `SESSION_SECRET="${secret(32)}"`,
    `ADMISSION_SECRET="${secret(32)}"`,
    "# Password for /admin.",
    `ADMIN_PASSWORD="${secret(8)}"`,
    "# Optional worker tuning (defaults shown).",
    'ADMIT_RATE_PER_SECOND="10"',
    'MAX_ACTIVE="100"',
    "",
  ];
  writeFileSync(envFile, lines.join("\n"));
  say("dev:local: wrote .env.dev (the /admin password is in it)");
}

// Commands are fixed strings run through the shell (pnpm is a .cmd shim on Windows); nothing
// user-supplied is ever spliced into them.
function step(title, command, env) {
  say(`\ndev:local: ${title}`);
  const result = spawnSync(command, { cwd: root, env, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`dev:local: "${title}" failed; see the output above`);
    process.exit(result.status ?? 1);
  }
}

if (spawnSync("docker info", { stdio: "ignore", shell: true }).status !== 0) {
  console.error("dev:local: Docker is not running. Start Docker Desktop and try again.");
  process.exit(1);
}
if (!existsSync(envFile)) {
  writeDefaultEnv();
}
const env = { ...process.env, ...parseEnv(readFileSync(envFile, "utf8")) };
// Both apps read PORT (the worker for its health endpoint), so each gets its own.
const webPort = env.PORT ?? "3000";
const workerPort = env.WORKER_PORT ?? "8080";

step(
  "starting Postgres, Redis and NATS (docker compose)",
  "docker compose up --detach --wait",
  env,
);
step("generating the Prisma client", "pnpm --filter @ticketarena/db db:generate", env);
step("applying migrations", "pnpm --filter @ticketarena/db db:deploy", env);
// The seed only inserts what is missing, so running it on every start is safe.
step("seeding the catalog", "pnpm --filter @ticketarena/worker db:seed", env);

const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) {
      continue;
    }
    // A shell sits between us and pnpm, next and tsx, so signalling the shell alone would leave
    // them running and holding their ports: stop the whole tree (Windows) or process group (POSIX).
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The group is already gone.
      }
    }
  }
  process.exitCode = code;
}

function run(name, command, port) {
  // On POSIX each service leads its own process group so stopAll can signal all of it.
  const child = spawn(command, {
    cwd: root,
    env: { ...env, PORT: port },
    shell: true,
    detached: !isWindows,
  });
  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    let pending = "";
    stream.on("data", (chunk) => {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        target.write(`${prefix}${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  // One of the two exiting leaves a half-working system, so the other one goes too.
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`dev:local: ${name} exited (${code ?? "signal"}); stopping the rest`);
      stopAll(code === 0 ? 1 : (code ?? 1));
    }
  });
  children.push(child);
}

say(
  `\ndev:local: web app on http://localhost:${webPort}, worker health on :${workerPort}; Ctrl+C stops both`,
);
say("dev:local: the compose services keep running; `pnpm infra:down` stops them");
run("web", "pnpm --filter @ticketarena/web dev", webPort);
run("worker", "pnpm --filter @ticketarena/worker start", workerPort);

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
