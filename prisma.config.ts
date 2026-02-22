import "dotenv/config";
import { defineConfig } from "prisma/config";

const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE } =
  process.env;

const url =
  process.env["DATABASE_URL"] ??
  `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST ?? "localhost"}:${POSTGRES_PORT ?? 5432}/${POSTGRES_DATABASE}`;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
});
