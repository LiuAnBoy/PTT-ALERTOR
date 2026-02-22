import { Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { runCleanup } from "../../../core/maintenance";
import { bullmqConnection } from "../../../core/queue";

const logger = createLogger("MAINTENANCE");

/**
 * BullMQ worker that runs periodic maintenance tasks.
 * Cleans up old articles, logs, and Redis cache.
 */
export const maintenanceWorker = new Worker(
  "maintenance-queue",
  async (job) => {
    logger.info(`Job ${job.id}: running cleanup`);
    await runCleanup();
  },
  { connection: bullmqConnection },
);

maintenanceWorker.on("failed", (job, err) => {
  logger.error(`Job ${job?.id} failed: ${err.message}`);
});
