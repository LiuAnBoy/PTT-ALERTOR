import { createLogger } from "./logger";
import { getPrisma } from "./prisma";
import { redis } from "./redis";

const logger = createLogger("MAINTENANCE");

const ARTICLE_RETENTION_DAYS = 7;
const LOG_RETENTION_DAYS = 30;

/**
 * Run all maintenance cleanup tasks.
 * - Delete articles older than 7 days
 * - Clean expired Redis article caches
 * - Delete crawler logs older than 30 days
 */
export async function runCleanup(): Promise<void> {
  const articlesDeleted = await cleanupArticles();
  const logsDeleted = await cleanupLogs();
  await cleanupRedisCache();

  logger.info(`Cleanup done: ${articlesDeleted} articles, ${logsDeleted} logs removed`);
}

/**
 * Delete articles older than ARTICLE_RETENTION_DAYS.
 * @returns Number of articles deleted.
 */
async function cleanupArticles(): Promise<number> {
  const cutoff = new Date(Date.now() - ARTICLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await getPrisma().article.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.debug(`Deleted ${result.count} articles older than ${ARTICLE_RETENTION_DAYS} days`);
  }

  return result.count;
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
 * Clean expired entries from all board article Redis ZSET caches.
 * Removes entries with timestamp older than ARTICLE_RETENTION_DAYS.
 */
async function cleanupRedisCache(): Promise<void> {
  const cutoffTimestamp = Math.floor(
    (Date.now() - ARTICLE_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000,
  );

  // Find all board cache keys
  const keys = await redis.keys("board:*:articles");
  if (keys.length === 0) return;

  const pipe = redis.pipeline();
  for (const key of keys) {
    pipe.zremrangebyscore(key, "-inf", cutoffTimestamp);
  }
  await pipe.exec();

  logger.debug(`Cleaned Redis cache for ${keys.length} boards`);
}
