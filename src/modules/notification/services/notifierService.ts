import { createLogger } from "../../../core/logger";
import { getPrisma } from "../../../core/prisma";
import { getAdapter } from "../../broadcast/registry";
import type { NotificationPayload } from "../../broadcast/types";
import { logError } from "../../user/services/errorLogger";

export type { NotificationPayload } from "../../broadcast/types";

const logger = createLogger("NOTIFIER");

/**
 * Send a notification to a user via all registered platform channels.
 * Looks up all channels for the user and dispatches via the appropriate adapter.
 *
 * @param payload - The notification data.
 * @returns True if sent successfully to at least one channel.
 */
export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  const user = await getPrisma().user.findUnique({
    where: { id: payload.userId },
    select: { enable: true, channels: true },
  });

  if (!user || !user.enable) return false;

  let sent = false;

  for (const channel of user.channels) {
    try {
      const adapter = getAdapter(channel.platform);
      await adapter.sendNotification(channel.platformChatId, payload);
      sent = true;
    } catch (err) {
      await logError("ERROR", "NOTIFIER", `${channel.platform} send failed`, {
        userId: payload.userId,
        channelId: channel.id,
        error: (err as Error).message,
      });
    }
  }

  if (sent) {
    logger.debug(`Notification sent to ${payload.userId}: ${payload.keyword}@${payload.board}`);
  }

  return sent;
}
