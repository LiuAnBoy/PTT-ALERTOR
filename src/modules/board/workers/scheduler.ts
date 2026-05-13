import { Queue } from "bullmq";

import { alertAggregator } from "../../../core/alertAggregator";
import { crawlerCircuit } from "../../../core/circuitBreaker";
import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { redis } from "../../../core/redis";
import { roundTracker } from "../../../core/roundTracker";
import { sendRecoveryAlert, sendSummaryAlert } from "../../user/services/errorLogger";

const logger = createLogger("SCHEDULER");

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  // Retention caps to prevent unbounded BullMQ growth in Redis.
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 * 7, count: 5000 },
};

export const crawlerQueue = new Queue("crawler-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});
export const updateQueue = new Queue("update-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});
export const maintenanceQueue = new Queue("maintenance-queue", {
  connection: bullmqConnection,
  defaultJobOptions,
});

/**
 * Dispatch queue for the meta-scheduler.
 * A repeatable job reads subscribed boards from Redis and dispatches crawler jobs.
 */
export const dispatchQueue = new Queue("dispatch-queue", {
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
 * Checks circuit breaker state before dispatching and handles recovery alerts.
 *
 * @returns Array of board names dispatched.
 */
export async function dispatchCrawlerJobs(): Promise<string[]> {
  const boards = await redis.smembers("boards");

  if (boards.length === 0) {
    logger.debug("No subscribed boards to crawl");
    return [];
  }

  // Circuit breaker gate
  if (crawlerCircuit.isOpen()) {
    if (crawlerCircuit.shouldAttempt()) {
      logger.info("Circuit HALF_OPEN: dispatching probe round");
    } else {
      logger.warn(`Circuit OPEN: skipping dispatch for ${boards.length} boards`);
      await sendSummaryAlert();
      return [];
    }
  }

  // Check if we just recovered (circuit CLOSED but alertAggregator still ALERTING)
  if (crawlerCircuit.getState() === "CLOSED" && alertAggregator.getState() === "ALERTING") {
    await sendRecoveryAlert();
  }

  roundTracker.startRound(boards.length);

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
