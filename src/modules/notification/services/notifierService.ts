import { createLogger } from "../../../core/logger";
import { getPrisma } from "../../../core/prisma";
import { getAdapter } from "../../broadcast/registry";
import type { NotificationPayload } from "../../broadcast/types";
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
 * Send a notification to a user via all registered platform channels.
 * Looks up all channels for the user and dispatches via the appropriate adapter.
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

  let sent = false;
  let temporaryError: Error | null = null;

  for (const channel of user.channels) {
    try {
      const adapter = getAdapter(channel.platform);
      await adapter.sendNotification(channel.platformChatId, payload);
      sent = true;
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
