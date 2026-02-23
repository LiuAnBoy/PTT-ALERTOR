import { Bot, type Context, webhookCallback } from "grammy";

import { config } from "../../../core/config";
import { createLogger } from "../../../core/logger";
import { clearErrors, getRecentErrors } from "../../user/services/errorLogger";
import {
  executeAdd,
  executeDelete,
  executeHelp,
  executeList,
  executeStart,
  parseCommand,
} from "../commandHandler";
import { registerAdapter } from "../registry";
import type { CommandContext, NotificationPayload, PlatformAdapter } from "../types";

const logger = createLogger("BOT");

const MAX_MESSAGE_LENGTH = 4096;
const WEBHOOK_PATH = "/api/telegram/webhook";

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

    bot = new Bot(config.telegram.token);

    bot.command("start", handleStart);
    bot.command("errors", handleErrors);
    bot.on("message:text", handleText);

    bot.catch((err) => {
      logger.error(`Bot error: ${err.message}`);
    });
  }
  return bot;
}

// ─── Webhook ────────────────────────────────────────────────────────────────

/**
 * Get the Express middleware handler for Telegram webhook.
 */
export function getWebhookHandler() {
  return webhookCallback(getBot(), "express", { secretToken: undefined });
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
  await getBot().api.setWebhook(fullUrl, { secret_token: undefined });
  logger.info(`Telegram webhook set: ${fullUrl}`);
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
  };
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
 */
async function handleText(ctx: Context) {
  const cmdCtx = toCommandContext(ctx);
  if (!cmdCtx || !cmdCtx.text) return;

  const parsed = parseCommand(cmdCtx.text);
  if (!parsed) return;

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
    default:
      return;
  }

  await ctx.reply(result.reply);
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

  const lines = logs.map((log) => {
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

  async sendNotification(chatId: string, payload: NotificationPayload): Promise<void> {
    const message = formatMessage(payload);
    await getBot().api.sendMessage(chatId, message, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  },

  async sendAlert(chatId: string, text: string): Promise<void> {
    await getBot().api.sendMessage(chatId, text);
  },

  rateLimit: { max: 30, duration: 1_000 },
};

// Self-register on import
registerAdapter(telegramAdapter);
