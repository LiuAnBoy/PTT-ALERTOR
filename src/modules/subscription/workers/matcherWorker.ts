import { Queue, Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { matchArticle } from "../services/matcherService";

const logger = createLogger("MATCHER");

/**
 * Queue for dispatching notification jobs after matching.
 */
const notifyQueue = new Queue("notify-queue", {
  connection: bullmqConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    // Retention caps to prevent unbounded BullMQ growth in Redis.
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 * 7, count: 5000 },
  },
});

/**
 * BullMQ worker that matches new articles against subscriptions.
 * Dispatches notification jobs for each match.
 */
export const matcherWorker = new Worker(
  "matcher-queue",
  async (job) => {
    const { board, title, code, author, pushSum, link } = job.data as {
      board: string;
      title: string;
      code: string;
      author: string | null;
      pushSum: number;
      link: string;
    };

    const matches = await matchArticle(board, title);
    if (matches.length === 0) return;

    logger.info(`Job ${job.id}: ${matches.length} matches for "${title}" on ${board}`);

    // Dispatch notification jobs
    for (const match of matches) {
      await notifyQueue.add("notify", {
        userId: match.userId,
        keyword: match.keyword,
        articleCode: code,
        board,
        title,
        author,
        pushSum,
        link,
      });
    }
  },
  { connection: bullmqConnection, concurrency: 5 },
);

matcherWorker.on("failed", (job, err) => {
  const attempt = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts?.attempts ?? 1;
  logger.error(`Job ${job?.id} failed (${attempt}/${maxAttempts}): ${err.message}`);
});

/**
 * Close the matcher worker and its notify queue.
 */
export async function closeMatcherWorker(): Promise<void> {
  await matcherWorker.close();
  await notifyQueue.close();
}
