import { Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { executeSendJob, executeVerifyJob } from "../services/mailService";
import { closeMailQueue, SEND_JOB, VERIFY_JOB, type VerifyJobData } from "./mailQueue";

const logger = createLogger("MAIL");

/**
 * BullMQ worker that runs PTT mail sends and account verifications one at a time,
 * at most one job per 5 seconds, so PTT never sees bursts of logins from this host.
 */
export const mailWorker = new Worker(
  "mail-queue",
  async (job) => {
    if (job.name === SEND_JOB) {
      await executeSendJob((job.data as { requestId: string }).requestId);
    } else if (job.name === VERIFY_JOB) {
      await executeVerifyJob(job.data as VerifyJobData);
    } else {
      throw new Error(`Unknown mail job name: ${job.name}`);
    }
  },
  {
    connection: bullmqConnection,
    concurrency: 1,
    limiter: { max: 1, duration: 5_000 },
    autorun: false,
  },
);

// Job data is never logged: verify jobs carry credentials.
mailWorker.on("failed", (job, err) => {
  logger.error(`Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

/**
 * Close the mail worker and its queue.
 */
export async function closeMailWorker(): Promise<void> {
  await mailWorker.close();
  await closeMailQueue();
}
