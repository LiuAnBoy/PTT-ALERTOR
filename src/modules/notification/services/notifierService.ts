import { createLogger } from "../../../core/logger";
import { getPrisma } from "../../../core/prisma";
import { getAdapter } from "../../broadcast/registry";
import type { ButtonRows, MessageRef, NotificationPayload } from "../../broadcast/types";
import { setMessageRef } from "../../mail/repositories/mailRequestRepository";
import { offerMail } from "../../mail/services/mailService";
import { logError } from "../../user/services/errorLogger";

export type { NotificationPayload } from "../../broadcast/types";

const logger = createLogger("NOTIFIER");

/** HTTP status codes that indicate permanent failures (no retry). */
const PERMANENT_ERROR_CODES = new Set([400, 401, 403, 404]);

/** Error messages from Telegram that indicate permanent failures. */
const PERMANENT_ERROR_PATTERNS = [
  "bot was blocked by the user",
  "user is deactivated",
  "chat not found",
  "bot was kicked",
  "PEER_ID_INVALID",
];

/**
 * Check if an error is permanent (should not be retried).
 * @internal Exported for testing.
 */
export function isPermanentError(err: unknown): boolean {
  const message = (err as Error).message ?? "";
  const status = (err as { response?: { status?: number } }).response?.status;

  if (status && PERMANENT_ERROR_CODES.has(status)) return true;
  return PERMANENT_ERROR_PATTERNS.some((p) => message.includes(p));
}

/**
 * Offer the mail button for a notification. A failure is logged and means no button: mail must
 * never block the notification itself.
 * @param payload - The notification about to be sent.
 * @returns The MailRequest id and the button rows, or null when no button applies.
 */
async function offerMailButton(
  payload: NotificationPayload,
): Promise<{ requestId: string; buttons: ButtonRows } | null> {
  try {
    const requestId = await offerMail(payload);
    if (!requestId) return null;
    return {
      requestId,
      buttons: [[{ text: `✉️ 寄信給 ${payload.author}`, action: `mail:${requestId}` }]],
    };
  } catch (err) {
    logger.warn(`Mail offer failed, sending without a button: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Remember the sent message on its MailRequest. A failure is logged only: the notification
 * has already gone out.
 * @param requestId - The MailRequest id.
 * @param ref - The sent message reference.
 */
async function storeMessageRef(requestId: string, ref: MessageRef): Promise<void> {
  try {
    await setMessageRef(requestId, ref.chatId, ref.messageId);
  } catch (err) {
    logger.warn(`Could not store the message reference: ${(err as Error).message}`);
  }
}

/**
 * Send a notification to a user via all registered platform channels.
 * Looks up all channels for the user and dispatches via the appropriate adapter.
 *
 * When the user may mail the author, the message carries a mail button and the sent message
 * reference is stored on the MailRequest so the result can be reported on it later.
 *
 * Permanent errors (bot blocked, user deactivated) are logged and skipped.
 * Temporary errors (network, rate limit) are re-thrown to let BullMQ retry.
 *
 * @param payload - The notification data.
 * @returns True if sent successfully to at least one channel.
 * @throws Re-throws temporary errors for BullMQ retry.
 */
export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  const user = await getPrisma().user.findUnique({
    where: { id: payload.userId },
    select: { enable: true, channels: true },
  });

  if (!user || !user.enable) return false;

  const offer = await offerMailButton(payload);
  let refStored = false;
  let sent = false;
  let temporaryError: Error | null = null;

  for (const channel of user.channels) {
    try {
      const adapter = getAdapter(channel.platform);
      const ref = offer
        ? await adapter.sendNotification(channel.platformChatId, payload, offer.buttons)
        : await adapter.sendNotification(channel.platformChatId, payload);
      sent = true;
      if (offer && ref && !refStored) {
        refStored = true;
        await storeMessageRef(offer.requestId, ref);
      }
    } catch (err) {
      if (isPermanentError(err)) {
        await logError("ERROR", "NOTIFIER", `${channel.platform} send failed (permanent)`, {
          userId: payload.userId,
          channelId: channel.id,
          error: (err as Error).message,
        });
      } else {
        await logError("ERROR", "NOTIFIER", `${channel.platform} send failed (temporary)`, {
          userId: payload.userId,
          channelId: channel.id,
          error: (err as Error).message,
        });
        temporaryError = err as Error;
      }
    }
  }

  if (sent) {
    logger.debug(`Notification sent to ${payload.userId}: ${payload.keyword}@${payload.board}`);
    return true;
  }

  // If all channels failed and at least one was temporary, re-throw for BullMQ retry
  if (temporaryError) {
    throw temporaryError;
  }

  return false;
}
