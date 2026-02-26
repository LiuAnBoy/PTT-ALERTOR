import { Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { logError } from "../../user/services/errorLogger";
import { dispatchCrawlerJobs } from "./scheduler";

const logger = createLogger("SCHEDULER");

/**
 * BullMQ worker that dispatches crawler jobs based on subscribed boards.
 * Reads the "boards" SET from Redis and creates a crawler job for each board.
 */
export const dispatchWorker = new Worker(
  "dispatch-queue",
  async (job) => {
    logger.debug(`Job ${job.id}: dispatching crawler jobs`);
    await dispatchCrawlerJobs();
  },
  { connection: bullmqConnection },
);

dispatchWorker.on("failed", (job, err) => {
  const attempt = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts?.attempts ?? 1;
  logger.error(`Dispatch job ${job?.id} failed (${attempt}/${maxAttempts}): ${err.message}`);

  if (attempt >= maxAttempts) {
    logError("ERROR", "SCHEDULER", "Dispatch job exhausted", {
      jobId: job?.id,
      attempts: attempt,
      error: err.message,
    }).catch(() => {});
  }
});
