import { createPrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
import { parseSeedEnv } from "./env.js";

// Entry point for `pnpm --filter @ticketarena/worker db:seed`. It lives in the worker app, not in
// `@ticketarena/db`, because packages never read the environment (TD-001); like the worker, it
// seeds over the direct URL with the `pg` driver.
const env = parseSeedEnv(process.env);
const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, driver: "pg" });
try {
  await seedCatalog(prisma, new Date());
} finally {
  await prisma.$disconnect();
}
