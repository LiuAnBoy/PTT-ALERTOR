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
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

/**
 * Connect to Redis, flush all data, and log the result.
 * Flush ensures no stale BullMQ schedulers or cached data persist across restarts.
 */
export async function connectRedis(): Promise<void> {
  await redis.connect();
  await redis.flushall();
  logger.info(`Redis connected on ${config.redis.host}:${config.redis.port} (flushed)`);
}
