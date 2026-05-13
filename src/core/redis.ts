import Redis from "ioredis";

import { config } from "./config";
import { createLogger } from "./logger";

const logger = createLogger("REDIS");

/**
 * Singleton Redis client instance.
 */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  db: config.redis.db,
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

/**
 * Connect to Redis, flush this app's db, and log the result.
 * Flush ensures no stale BullMQ schedulers or cached data persist across restarts.
 * Uses flushdb (not flushall) to avoid wiping other services that share this instance.
 */
export async function connectRedis(): Promise<void> {
  await redis.connect();
  await redis.flushdb();
  logger.info(
    `Redis connected on ${config.redis.host}:${config.redis.port} db=${config.redis.db} (flushed)`,
  );
}
