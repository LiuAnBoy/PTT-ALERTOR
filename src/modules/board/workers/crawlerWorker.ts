import { Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { logError } from "../../user/services/errorLogger";
import { fetchNewArticles } from "../services/crawlerService";

const logger = createLogger("CRAWLER");

/**
 * BullMQ worker that processes crawler jobs.
 * Each job contains a boardName and triggers article fetching.
 */
export const crawlerWorker = new Worker(
  "crawler-queue",
  async (job) => {
    const { boardName } = job.data as { boardName: string };
    logger.info(`Job ${job.id}: crawling ${boardName}`);

    const articles = await fetchNewArticles(boardName);
    logger.info(`Job ${job.id}: found ${articles.length} new articles from ${boardName}`);
  },
  { connection: bullmqConnection, concurrency: 5 },
);

crawlerWorker.on("failed", (job, err) => {
  const attempt = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts?.attempts ?? 1;
  logger.error(`Job ${job?.id} failed (${attempt}/${maxAttempts}): ${err.message}`);

  if (attempt >= maxAttempts) {
    const boardName = (job?.data as { boardName?: string })?.boardName ?? "unknown";
    logError("ERROR", "CRAWLER", `Crawl job exhausted: ${boardName}`, {
      jobId: job?.id,
      attempts: attempt,
      error: err.message,
    }).catch(() => {});
  }
});
