import https from "node:https";

import { Bot, type Context, InlineKeyboard, webhookCallback } from "grammy";

import { config } from "../../../core/config";
import { createLogger } from "../../../core/logger";
import { describeRequestOutcome, MAIL_TEXT, requestMail } from "../../mail/services/mailService";
import { clearErrors, getRecentErrors } from "../../user/services/errorLogger";
import {
  executeAdd,
  executeBindStart,
  executeBoardStats,
  executeDelete,
  executeHelp,
  executeList,
  executeStart,
  executeSubAction,
  executeUnbind,
  getUser,
  handlePending,
  parseCommand,
} from "../commandHandler";
import { registerAdapter } from "../registry";
import type {
  ButtonRows,
  CommandContext,
  CommandResult,
  MessageRef,
  NotificationPayload,
  PlatformAdapter,
} from "../types";

/** Subset of CrawlerLog fields used in the error report formatter. */
interface ErrorLogEntry {
  createdAt: Date;
  level: string;
  module: string;
  message: string;
  notified: boolean;
}

const logger = createLogger("BOT");

const MAX_MESSAGE_LENGTH = 4096;
const WEBHOOK_PATH = "/api/telegram/webhook";
/** Callback data of the inert "sending" button that replaces the mail button. */
const MAIL_NOOP = "mail:noop";
/** Telegram errors that mean an edit has nothing left to do. */
const BENIGN_EDIT_ERRORS = ["message is not modified", "message to edit not found"];

let bot: Bot | null = null;

// ─── Bot Instance ───────────────────────────────────────────────────────────

/**
 * Get or create the bot instance (lazy initialization).
 */
export function getBot(): Bot {
  if (!bot) {
    if (!config.telegram.token) {
      throw new Error("TELEGRAM_TOKEN is not set");
    }

    const agent = new https.Agent({ family: 4, keepAlive: true });
    bot = new Bot(config.telegram.token, {
      client: { baseFetchConfig: { agent } },
    });

    bot.command("start", handleStart);
    bot.command("errors", handleErrors);
    bot.on("message:text", handleText);
    bot.on("callback_query:data", handleCallbackQuery);

    // Log only the update id and the error name: the error text and the update may carry
    // message text (a PTT password included).
    bot.catch((err) => {
      logger.error(`Bot error on update ${err.ctx.update.update_id}: ${errorName(err.error)}`);
    });
  }
  return bot;
}

// ─── Webhook ────────────────────────────────────────────────────────────────

/**
 * Get the Express middleware handler for Telegram webhook.
 */
export function getWebhookHandler() {
  return webhookCallback(getBot(), "express", { secretToken: webhookSecret() });
}

/**
 * The configured webhook secret.
 * @returns The secret, or undefined when none is set (Telegram then sends no header).
 */
function webhookSecret(): string | undefined {
  return config.telegram.webhookSecret || undefined;
}

/**
 * Name of an unknown thrown value, without its message.
 * @param error - The thrown value.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Get the full webhook path.
 */
export function getWebhookPath(): string {
  return WEBHOOK_PATH;
}

/**
 * Register the webhook URL with Telegram.
 */
export async function startBot(): Promise<void> {
  const fullUrl = `${config.telegram.webhookUrl}${WEBHOOK_PATH}`;
  try {
    await getBot().api.setWebhook(fullUrl, { secret_token: webhookSecret() });
    logger.info(`Telegram webhook set: ${fullUrl}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error}`);
  }
}

/**
 * Remove the webhook and stop the bot gracefully.
 */
export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.api.deleteWebhook();
    logger.info("Telegram webhook removed");
  }
}

// ─── Receiving (Context → CommandContext) ────────────────────────────────────

/**
 * Convert Grammy Context to platform-agnostic CommandContext.
 */
function toCommandContext(ctx: Context): CommandContext | null {
  if (!ctx.from) return null;
  const { id, first_name, last_name, username, language_code, is_premium, is_bot } = ctx.from;
  return {
    platform: "TELEGRAM",
    platformUserId: id.toString(),
    platformChatId: (ctx.chat?.id ?? id).toString(),
    displayName: [first_name, last_name].filter(Boolean).join(" ") || undefined,
    rawData: { id, first_name, last_name, username, language_code, is_premium, is_bot },
    text: ctx.message?.text?.trim() ?? "",
    rawText: ctx.message?.text ?? "",
    isPrivate: ctx.chat?.type === "private",
    deleteInputMessage: async () => {
      await ctx.deleteMessage();
    },
  };
}

/**
 * Map platform-agnostic buttons to a Telegram inline keyboard.
 * @param buttons - Rows of buttons, if any.
 * @returns The keyboard, or undefined when there are no buttons.
 */
function toKeyboard(buttons?: ButtonRows): InlineKeyboard | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((row, index) => {
    if (index > 0) keyboard.row();
    for (const button of row) keyboard.text(button.text, button.action);
  });
  return keyboard;
}

/**
 * Send a command result as a reply, with its buttons as an inline keyboard.
 * @param ctx - The Grammy context.
 * @param result - The result to send.
 */
async function replyWith(ctx: Context, result: CommandResult): Promise<void> {
  const keyboard = toKeyboard(result.buttons);
  await (keyboard ? ctx.reply(result.reply, { reply_markup: keyboard }) : ctx.reply(result.reply));
}

/**
 * Handle /start command.
 */
async function handleStart(ctx: Context) {
  const cmdCtx = toCommandContext(ctx);
  if (!cmdCtx) return;
  const result = await executeStart(cmdCtx);
  await ctx.reply(result.reply);
}

/**
 * Route incoming text messages to the shared command handler.
 * A pending multi-step input (bind ID, password, reply text) is consumed before parsing.
 * @internal Exported for unit testing only.
 */
export async function handleText(ctx: Context) {
  const cmdCtx = toCommandContext(ctx);
  if (!cmdCtx || !cmdCtx.text) return;

  const pending = await handlePending(cmdCtx);
  if (pending) {
    await replyWith(ctx, pending);
    return;
  }

  const parsed = parseCommand(cmdCtx.text);
  if (!parsed) {
    await ctx.reply("❌ 無法辨識的指令。輸入「幫助」查看可用指令。");
    return;
  }

  let result;
  switch (parsed.command) {
    case "help":
      result = executeHelp();
      break;
    case "list":
      result = await executeList(cmdCtx);
      break;
    case "add":
      result = await executeAdd(cmdCtx, parsed.args);
      break;
    case "delete":
      result = await executeDelete(cmdCtx, parsed.args);
      break;
    case "boardStats":
      result = await executeBoardStats(parsed.args);
      break;
    case "bindPtt":
      result = await executeBindStart(cmdCtx);
      break;
    case "unbindPtt":
      result = await executeUnbind(cmdCtx);
      break;
    default:
      return;
  }

  await replyWith(ctx, result);
}

/** What a callback press answers with: a toast, or a modal alert when `alert` is set. */
interface CallbackAnswer {
  text: string;
  alert?: boolean;
}

/**
 * Route inline-button presses by callback-data prefix: `sub:` is the reply-settings card and
 * `mail:` the mail button on a notification. Always answers the callback query.
 * @internal Exported for unit testing only.
 */
export async function handleCallbackQuery(ctx: Context) {
  const data = ctx.callbackQuery?.data ?? "";
  let answer: CallbackAnswer | undefined;
  try {
    if (data.startsWith("sub:")) {
      const toast = await handleSubCallback(ctx, data);
      answer = toast ? { text: toast } : undefined;
    } else if (data.startsWith("mail:")) {
      answer = await handleMailCallback(ctx, data);
    }
  } catch (err) {
    logger.error(`Callback failed: ${errorName(err)}`);
    answer = { text: "發生錯誤，請稍後再試" };
  } finally {
    const options = answer ? { text: answer.text, show_alert: answer.alert } : undefined;
    await ctx.answerCallbackQuery(options).catch(() => undefined);
  }
}

/**
 * Run a `mail:<id>` press: only the notification's owner may claim it, and only the first tap
 * does. A claimed tap swaps the button for an inert "sending" one; a refusal leaves the
 * message alone and is explained in the answer.
 * @param ctx - The Grammy context of the callback query.
 * @param data - The callback data.
 * @returns The answer to show for the press, if any.
 */
async function handleMailCallback(ctx: Context, data: string): Promise<CallbackAnswer | undefined> {
  if (data === MAIL_NOOP) return undefined;
  const requestId = data.slice("mail:".length);
  const cmdCtx = toCommandContext(ctx);
  if (!cmdCtx || !requestId) return { text: "無法辨識的操作" };

  const user = await getUser(cmdCtx);
  if (!user) return { text: "請先輸入 /start 來開始使用。", alert: true };

  // The tapped message is stored by requestMail, before the send job exists, when the request
  // has none on record (the store at send time failed).
  const tapped = ctx.callbackQuery?.message;
  const outcome = await requestMail(
    requestId,
    user.id,
    tapped ? { chatId: String(tapped.chat.id), messageId: String(tapped.message_id) } : undefined,
  );
  if (outcome.kind !== "queued") {
    const alert =
      outcome.kind === "not_owner" ||
      outcome.kind === "cap_reached" ||
      outcome.kind === "attempts_exhausted";
    return { text: describeRequestOutcome(outcome), alert };
  }

  try {
    const sending = toKeyboard([[{ text: MAIL_TEXT.sending, action: MAIL_NOOP }]]);
    await ctx.editMessageReplyMarkup({ reply_markup: sending });
  } catch (err) {
    // The claim stands and the result will be reported either way.
    logger.warn(`Could not swap the mail button: ${errorName(err)}`);
  }
  return undefined;
}

/**
 * Run a `sub:<id>:<action>` press for the user who pressed it.
 * @param ctx - The Grammy context of the callback query.
 * @param data - The callback data.
 * @returns A toast text for the press, if any.
 */
async function handleSubCallback(ctx: Context, data: string): Promise<string | undefined> {
  const [, subscriptionId, action] = data.split(":");
  const cmdCtx = toCommandContext(ctx);
  if (!cmdCtx || !subscriptionId || !action) return "無法辨識的操作";

  const result = await executeSubAction(cmdCtx, subscriptionId, action);
  const keyboard = toKeyboard(result.buttons);
  if (result.edit) {
    try {
      await ctx.editMessageText(result.reply, keyboard ? { reply_markup: keyboard } : undefined);
      return result.toast;
    } catch {
      // Unchanged text or a message too old to edit: fall through and send a new message.
    }
  }
  await replyWith(ctx, result);
  return result.toast;
}

/**
 * Handle /errors command - show recent error logs (admin only).
 */
async function handleErrors(ctx: Context) {
  if (!ctx.from || !config.telegram.adminChatId) return;
  if (String(ctx.from.id) !== config.telegram.adminChatId) return;

  const text = ctx.message?.text?.trim() ?? "";

  if (text.includes("clear")) {
    const count = await clearErrors();
    await ctx.reply(`✅ 已標記 ${count} 筆錯誤為已處理。`);
    return;
  }

  const logs = await getRecentErrors();

  if (logs.length === 0) {
    await ctx.reply("✅ 過去 24 小時內無錯誤記錄。");
    return;
  }

  const lines = logs.map((log: ErrorLogEntry) => {
    const time = log.createdAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    const icon = log.level === "FATAL" ? "🚨" : log.level === "ERROR" ? "⚠️" : "⚡";
    const notified = log.notified ? "✓" : "✗";
    return `${icon} [${log.level}] ${log.module} | ${log.message} | ${time} [${notified}]`;
  });

  let message = `📋 最近 24 小時錯誤記錄（${logs.length} 筆）：\n\n${lines.join("\n")}`;
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
  }

  await ctx.reply(message);
}

// ─── Sending (PlatformAdapter) ──────────────────────────────────────────────

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * @internal Exported for unit testing only.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format a notification payload into Telegram HTML message.
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
 * Telegram platform adapter — handles sending messages via Grammy Bot API.
 */
export const telegramAdapter: PlatformAdapter = {
  platform: "TELEGRAM",

  async sendReply(chatId: string, text: string): Promise<void> {
    await getBot().api.sendMessage(chatId, text);
  },

  async sendNotification(
    chatId: string,
    payload: NotificationPayload,
    buttons?: ButtonRows,
  ): Promise<MessageRef | void> {
    const keyboard = toKeyboard(buttons);
    const sent = await getBot().api.sendMessage(chatId, formatMessage(payload), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (sent?.message_id === undefined) return;
    return { chatId, messageId: String(sent.message_id) };
  },

  async updateMessage(target: MessageRef, text: string, buttons?: ButtonRows): Promise<void> {
    const { api } = getBot();
    const messageId = Number(target.messageId);
    try {
      await api.editMessageReplyMarkup(target.chatId, messageId, {
        reply_markup: toKeyboard(buttons) ?? { inline_keyboard: [] },
      });
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!BENIGN_EDIT_ERRORS.some((known) => message.includes(known))) throw err;
      logger.info(`Keyboard of message ${messageId} left as is: ${errorName(err)}`);
    }
    await api.sendMessage(target.chatId, text, {
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
    });
  },

  async sendAlert(chatId: string, text: string): Promise<void> {
    await getBot().api.sendMessage(chatId, text);
  },

  rateLimit: { max: 30, duration: 1_000 },
};

// Self-register on import
registerAdapter(telegramAdapter);
