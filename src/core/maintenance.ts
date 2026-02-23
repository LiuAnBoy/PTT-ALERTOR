import { cleanActiveArticles } from "../modules/board/services/articleCache";
import { createLogger } from "./logger";
import { getPrisma } from "./prisma";

const logger = createLogger("MAINTENANCE");

const LOG_RETENTION_DAYS = 30;

/** Cleanup window for active articles ZSET (24 hours). */
const ACTIVE_ARTICLES_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Run all maintenance cleanup tasks.
 * - Clean expired Redis active articles (older than 24h)
 * - Delete crawler logs older than 30 days
 */
export async function runCleanup(): Promise<void> {
  const redisCleanCount = await cleanupRedisCache();
  const logsDeleted = await cleanupLogs();

  logger.info(`Cleanup done: ${redisCleanCount} Redis entries, ${logsDeleted} logs removed`);
}

/**
 * Delete crawler logs older than LOG_RETENTION_DAYS.
 * @returns Number of logs deleted.
 */
async function cleanupLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await getPrisma().crawlerLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.debug(`Deleted ${result.count} logs older than ${LOG_RETENTION_DAYS} days`);
  }

  return result.count;
}

/**
 * Clean expired entries from the active articles Redis ZSET.
 * Removes entries with timestamp older than 24 hours.
 * @returns Number of entries removed.
 */
async function cleanupRedisCache(): Promise<number> {
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - ACTIVE_ARTICLES_WINDOW_SECONDS;
  const count = await cleanActiveArticles(cutoffTimestamp);

  if (count > 0) {
    logger.debug(`Cleaned ${count} expired entries from active articles cache`);
  }

  return count;
}
