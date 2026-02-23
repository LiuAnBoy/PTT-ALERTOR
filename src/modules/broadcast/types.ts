import type { Platform } from "@prisma/client";

/**
 * Platform-agnostic command context.
 * Platform adapters translate their native context into this.
 */
export interface CommandContext {
  /** Platform identifier (TELEGRAM, DISCORD, etc.) */
  platform: Platform;
  /** User ID on the platform (stringified) */
  platformUserId: string;
  /** Chat/Channel ID for sending replies */
  platformChatId: string;
  /** Optional username on the platform */
  username?: string;
  /** The raw text message from the user */
  text: string;
}

/**
 * Result of a command handler.
 * Shared logic returns this; the adapter sends the reply.
 */
export interface CommandResult {
  /** The reply text to send back to the user */
  reply: string;
}

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
 * Adapter interface for platform-specific message sending.
 * Each platform implements this to handle outbound messages.
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: Platform;

  /**
   * Send a plain text reply to the user.
   * @param chatId - The chat/channel ID.
   * @param text - The message text.
   */
  sendReply(chatId: string, text: string): Promise<void>;

  /**
   * Send a notification message with platform-specific formatting.
   * @param chatId - The chat/channel ID.
   * @param payload - The notification payload.
   */
  sendNotification(chatId: string, payload: NotificationPayload): Promise<void>;

  /**
   * Send an admin alert message.
   * @param chatId - The admin chat ID.
   * @param text - The alert text.
   */
  sendAlert(chatId: string, text: string): Promise<void>;

  /** Rate limit config for the notification worker */
  readonly rateLimit: { max: number; duration: number };
}
