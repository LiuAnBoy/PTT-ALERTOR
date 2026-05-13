import type { ConnectionOptions } from "bullmq";

import { config } from "./config";

/**
 * Shared Redis connection config for BullMQ.
 * BullMQ manages its own IORedis connections internally.
 */
export const bullmqConnection: ConnectionOptions = {
  host: config.redis.host,
  port: config.redis.port,
  db: config.redis.db,
};
