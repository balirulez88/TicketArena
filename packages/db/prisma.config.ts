import { defineConfig } from "prisma/config";

// `prisma generate` must work without a database (CI, sandbox, fresh clones), so the URL
// is read leniently here. Only migrate/deploy commands actually connect.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
