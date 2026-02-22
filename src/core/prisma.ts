import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { config } from "./config";
import { createLogger } from "./logger";

const logger = createLogger("DATABASE");

let _prisma: PrismaClient | null = null;

/**
 * Lazy-initialized singleton Prisma Client instance.
 * Ensures environment variables are loaded before creating the adapter.
 */
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    const adapter = new PrismaPg({ connectionString: config.postgres.url });
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

/**
 * Prisma client accessor for convenience.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: string | symbol) {
    return (getPrisma() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Connect to PostgreSQL and log the result.
 */
export async function connectDatabase(): Promise<void> {
  await getPrisma().$connect();
  const { host, port, database } = config.postgres;
  logger.info(`PostgreSQL connected on ${host}:${port}/${database}`);
}
