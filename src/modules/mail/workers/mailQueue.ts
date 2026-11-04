import { Queue } from "bullmq";

import { bullmqConnection } from "../../../core/queue";

/** Job name of a mail send (payload: `{ requestId }`). */
export const SEND_JOB = "send";
/** Job name of a PTT account verification (payload: {@link VerifyJobData}). */
export const VERIFY_JOB = "verify";

/** Payload of a `verify` job; carries the ciphertext, never the plaintext password. */
export interface VerifyJobData {
  userId: string;
  chatId: string;
  pttId: string;
  passwordEnc: string;
}

/**
 * Queue for PTT logins and mails. Jobs are only a trigger: the MailRequest row in Postgres is
 * the durable state, so there is no automatic retry (attempts 1) to avoid repeated logins.
 */
export const mailQueue = new Queue("mail-queue", {
  connection: bullmqConnection,
  defaultJobOptions: {
    attempts: 1,
    // Retention caps to prevent unbounded BullMQ growth in Redis.
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 * 7, count: 5000 },
  },
});

/**
 * Close the mail queue.
 */
export async function closeMailQueue(): Promise<void> {
  await mailQueue.close();
}
