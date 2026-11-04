import { DelayedError, type Job, Worker } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { type DeferredJob, executeSendJob, executeVerifyJob } from "../services/mailService";
import { closeMailQueue, SEND_JOB, VERIFY_JOB, type VerifyJobData } from "./mailQueue";

const logger = createLogger("MAIL");

/**
 * Run one mail job, and move it back to the delayed set when the account's login gap is not
 * over yet. A delay does not count as an attempt.
 * @param job - The BullMQ job.
 * @param token - The worker's lock token, required to move the active job.
 * @throws DelayedError after moving the job, so BullMQ neither completes nor fails it.
 */
async function processMailJob(job: Job, token?: string): Promise<void> {
  let deferred: DeferredJob | undefined;
  if (job.name === SEND_JOB) {
    deferred = await executeSendJob((job.data as { requestId: string }).requestId);
  } else if (job.name === VERIFY_JOB) {
    deferred = await executeVerifyJob(job.data as VerifyJobData);
  } else {
    throw new Error(`Unknown mail job name: ${job.name}`);
  }
  if (deferred) {
    await job.moveToDelayed(Date.now() + deferred.deferMs, token);
    throw new DelayedError();
  }
}

/**
 * BullMQ worker that runs PTT mail sends and account verifications one at a time, at most one
 * job per 5 seconds; the login gate also keeps each PTT account to one login per 3 minutes.
 */
export const mailWorker = new Worker("mail-queue", processMailJob, {
  connection: bullmqConnection,
  concurrency: 1,
  limiter: { max: 1, duration: 5_000 },
  autorun: false,
});

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
