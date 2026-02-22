import { createLogger } from "../../../core/logger";
import { getPrisma } from "../../../core/prisma";
import { getBot } from "../../user/bot/bot";
import { logError } from "../../user/services/errorLogger";

const logger = createLogger("NOTIFIER");

const MAX_MESSAGE_LENGTH = 4096;

/**
 * Notification payload for sending to a user.
 */
export interface NotificationPayload {
  userId: string;
  keyword: string;
  articleCode: string;
  board: string;
  title: string;
  author: string | null;
  pushSum: number;
  link: string;
}

/**
 * Send a notification to a user via Telegram.
 * Looks up the user's telegramChat from the database.
 *
 * @param payload - The notification data.
 * @returns True if sent successfully.
 */
export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  const user = await getPrisma().user.findUnique({
    where: { id: payload.userId },
    select: { enable: true, channels: { where: { platform: "TELEGRAM" } } },
  });

  if (!user || !user.enable) return false;

  const message = formatMessage(payload);
  let sent = false;

  for (const channel of user.channels) {
    try {
      await getBot().api.sendMessage(channel.platformChatId, message, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      sent = true;
    } catch (err) {
      await logError("ERROR", "NOTIFIER", `Telegram send failed`, {
        userId: payload.userId,
        channelId: channel.id,
        telegramError: (err as Error).message,
      });
    }
  }

  if (sent) {
    logger.debug(`Notification sent to ${payload.userId}: ${payload.keyword}@${payload.board}`);
  }

  return sent;
}

/**
 * Format a notification message.
 * @param payload - The notification data.
 * @returns Formatted message string (HTML).
 */
/**
 * @internal Exported for unit testing only.
 */
export function formatMessage(payload: NotificationPayload): string {
  const parts = [
    `🔔 <b>${escapeHtml(payload.keyword)}</b>@${escapeHtml(payload.board)}`,
    "",
    `👤 ${escapeHtml(payload.author ?? "unknown")}`,
    `📰 ${escapeHtml(payload.title)}`,
    "",
    `🔗 ${payload.link}`,
  ];

  let message = parts.join("\n");
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
  }

  return message;
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
/**
 * @internal Exported for unit testing only.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
