import { Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { updateActiveArticles } from "../services/crawlerService";

const logger = createLogger("WORKER");

/**
 * BullMQ worker that processes article update jobs.
 * Refreshes detail data for all active (non-expired) articles.
 */
export const updateWorker = new Worker(
  "update-queue",
  async (job) => {
    logger.info(`Job ${job.id}: updating active articles`);

    const updated = await updateActiveArticles();
    logger.info(`Job ${job.id}: updated ${updated} articles`);
  },
  { connection: bullmqConnection },
);

updateWorker.on("failed", (job, err) => {
  const attempt = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts?.attempts ?? 1;
  logger.error(`Job ${job?.id} failed (${attempt}/${maxAttempts}): ${err.message}`);
});
