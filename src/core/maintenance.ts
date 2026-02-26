import { cleanActiveArticles } from "../modules/board/services/articleCache";
import { createLogger } from "./logger";
import { getPrisma } from "./prisma";

const logger = createLogger("MAINTENANCE");

const LOG_RETENTION_DAYS = 30;

/** Cleanup window for active articles ZSET (24 hours). */
const ACTIVE_ARTICLES_WINDOW_SECONDS = 24 * 60 * 60;

/** Grace period before removing failed BullMQ jobs (24 hours). */
const FAILED_JOB_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Run all maintenance cleanup tasks.
 * - Clean expired Redis active articles (older than 24h)
 * - Delete crawler logs older than 30 days
 * - Remove failed BullMQ jobs older than 24h
 */
export async function runCleanup(): Promise<void> {
  const redisCleanCount = await cleanupRedisCache();
  const logsDeleted = await cleanupLogs();
  const failedJobsCleaned = await cleanupFailedJobs();

  logger.info(
    `Cleanup done: ${redisCleanCount} Redis entries, ${logsDeleted} logs, ${failedJobsCleaned} failed jobs removed`,
  );
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

/**
 * Remove failed BullMQ jobs older than 24 hours from all queues.
 * Uses dynamic import to avoid circular dependency with the scheduler module.
 * @returns Total number of failed jobs removed.
 */
async function cleanupFailedJobs(): Promise<number> {
  const { crawlerQueue, updateQueue, maintenanceQueue, dispatchQueue } =
    await import("../modules/board/workers/scheduler.js");
  const queues = [crawlerQueue, updateQueue, maintenanceQueue, dispatchQueue];
  let total = 0;

  for (const queue of queues) {
    try {
      const cleaned = await queue.clean(FAILED_JOB_GRACE_MS, 100, "failed");
      total += cleaned.length;
    } catch (err) {
      logger.error(`Failed to clean queue ${queue.name}: ${(err as Error).message}`);
    }
  }

  if (total > 0) {
    logger.debug(`Cleaned ${total} failed jobs from BullMQ queues`);
  }

  return total;
}
