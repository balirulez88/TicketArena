import { createPrismaClient } from "./index";
import { seedCatalog } from "./seed";

// Entry point for `pnpm db:seed`: the one place this package reads the environment, because
// it is a command-line boundary rather than library code.
const connectionString = process.env["DATABASE_URL"];
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("db:seed: DATABASE_URL must be set to a Postgres URL");
}
const prisma = createPrismaClient({ connectionString, driver: "pg" });
try {
  await seedCatalog(prisma, new Date());
} finally {
  await prisma.$disconnect();
}
