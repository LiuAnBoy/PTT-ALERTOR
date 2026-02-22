import { Queue } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { redis } from "../../../core/redis";

const logger = createLogger("SCHEDULER");

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
};

const crawlerQueue = new Queue("crawler-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});
const updateQueue = new Queue("update-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});
const maintenanceQueue = new Queue("maintenance-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});

/**
 * Dispatch queue for the meta-scheduler.
 * A repeatable job reads subscribed boards from Redis and dispatches crawler jobs.
 */
const dispatchQueue = new Queue("dispatch-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});

/**
 * Start repeatable job schedulers.
 * - Dispatch: every 1 minute, reads subscribed boards from Redis and dispatches crawler jobs
 * - Update: every 15 minutes
 * - Cleanup: every 1 hour
 */
export async function startScheduler(): Promise<void> {
  await dispatchQueue.upsertJobScheduler(
    "dispatch-boards",
    { every: 60_000 },
    { name: "dispatch", data: {} },
  );

  await updateQueue.upsertJobScheduler(
    "update-active",
    { every: 900_000 },
    { name: "update", data: {} },
  );

  await maintenanceQueue.upsertJobScheduler(
    "cleanup",
    { every: 3_600_000 },
    { name: "cleanup", data: {} },
  );

  logger.info("Schedulers started: dispatch (1m), update (15m), cleanup (1h)");
}

/**
 * Read subscribed boards from Redis and dispatch a crawler job for each.
 * Called by the dispatch worker every minute.
 *
 * @returns Array of board names dispatched.
 */
export async function dispatchCrawlerJobs(): Promise<string[]> {
  const boards = await redis.smembers("boards");

  if (boards.length === 0) {
    logger.debug("No subscribed boards to crawl");
    return [];
  }

  for (const board of boards) {
    await crawlerQueue.add("crawl", { boardName: board });
  }

  logger.info(`Dispatched crawler jobs for ${boards.length} boards: ${boards.join(", ")}`);
  return boards;
}

/**
 * Close scheduler queues gracefully.
 */
export async function stopScheduler(): Promise<void> {
  await dispatchQueue.close();
  await crawlerQueue.close();
  await updateQueue.close();
  await maintenanceQueue.close();
  logger.info("Schedulers stopped");
}
