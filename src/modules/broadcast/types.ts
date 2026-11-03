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
  /** Display name on the platform (e.g. Telegram first_name) */
  displayName?: string;
  /** Raw platform user data for storage */
  rawData?: Record<string, unknown>;
  /** The raw text message from the user */
  text: string;
  /** True when the message came from a one-to-one chat (never set for groups or channels) */
  isPrivate?: boolean;
  /** Deletes the user's incoming message; rejects when the platform refuses */
  deleteInputMessage?: () => Promise<void>;
}

/** One action button; `action` is the callback payload (at most 64 bytes). */
export interface ActionButton {
  text: string;
  action: string;
}

/** Rows of action buttons shown under a message. */
export type ButtonRows = ActionButton[][];

/** Reference to a message the bot sent: where it lives, to edit or reply to it later. */
export interface MessageRef {
  chatId: string;
  messageId: string;
}

/**
 * Result of a command handler.
 * Shared logic returns this; the adapter sends the reply.
 */
export interface CommandResult {
  /** The reply text to send back to the user */
  reply: string;
  /** Optional action buttons shown under the reply */
  buttons?: ButtonRows;
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
   * @param buttons - Optional rows of action buttons shown under the notification.
   * @returns The sent message reference, or nothing when the platform cannot provide one.
   */
  sendNotification(
    chatId: string,
    payload: NotificationPayload,
    buttons?: ButtonRows,
  ): Promise<MessageRef | void>;

  /**
   * Send an admin alert message.
   * @param chatId - The admin chat ID.
   * @param text - The alert text.
   */
  sendAlert(chatId: string, text: string): Promise<void>;

  /**
   * Report a status on a message this bot sent earlier (optional; callers fall back to
   * `sendReply`). The original message text stays as it was.
   * @param target - The chat and message the status belongs to.
   * @param text - The status text, posted as a reply to that message.
   * @param buttons - Rows of action buttons the message shows afterwards; omitted removes
   *   any keyboard.
   */
  updateMessage?(target: MessageRef, text: string, buttons?: ButtonRows): Promise<void>;

  /** Rate limit config for the notification worker */
  readonly rateLimit: { max: number; duration: number };
}
