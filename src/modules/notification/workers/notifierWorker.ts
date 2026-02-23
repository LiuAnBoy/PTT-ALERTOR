import { Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import type { NotificationPayload } from "../../broadcast/types";
import { sendNotification } from "../services/notifierService";

const logger = createLogger("NOTIFIER");

/**
 * BullMQ worker that sends Telegram notifications.
 * Rate limited to 30 messages per second to avoid Telegram 429 errors.
 */
export const notifierWorker = new Worker(
  "notify-queue",
  async (job) => {
    const payload = job.data as NotificationPayload;
    const sent = await sendNotification(payload);

    if (sent) {
      logger.debug(
        `Job ${job.id}: notified ${payload.userId} for ${payload.keyword}@${payload.board}`,
      );
    }
  },
  {
    connection: bullmqConnection,
    concurrency: 1,
    limiter: { max: 30, duration: 1_000 },
  },
);

notifierWorker.on("failed", (job, err) => {
  const attempt = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts?.attempts ?? 1;
  logger.error(`Job ${job?.id} failed (${attempt}/${maxAttempts}): ${err.message}`);
});
