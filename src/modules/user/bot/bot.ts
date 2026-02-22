import { Bot, webhookCallback } from "grammy";

import { config } from "../../../core/config";
import { createLogger } from "../../../core/logger";
import { handleErrors } from "./adminHandlers";
import { handleStart, handleText } from "./handlers";

const logger = createLogger("BOT");

/** Webhook path for Telegram updates. */
const WEBHOOK_PATH = "/api/telegram/webhook";

let bot: Bot | null = null;

/**
 * Get or create the bot instance (lazy initialization).
 * Ensures dotenv has loaded before reading TELEGRAM_TOKEN.
 */
export function getBot(): Bot {
  if (!bot) {
    if (!config.telegram.token) {
      throw new Error("TELEGRAM_TOKEN is not set");
    }

    bot = new Bot(config.telegram.token);

    // Command handlers
    bot.command("start", handleStart);
    bot.command("errors", handleErrors);

    // Text message handler (Chinese commands)
    bot.on("message:text", handleText);

    // Catch unhandled errors
    bot.catch((err) => {
      logger.error(`Bot error: ${err.message}`);
    });
  }
  return bot;
}

/**
 * Get the Express middleware handler for Telegram webhook.
 * @returns Express request handler.
 */
export function getWebhookHandler() {
  return webhookCallback(getBot(), "express", {
    secretToken: config.telegram.webhookSecret || undefined,
  });
}

/**
 * Get the full webhook path.
 */
export function getWebhookPath(): string {
  return WEBHOOK_PATH;
}

/**
 * Register the webhook URL with Telegram.
 * Tells Telegram to send updates to our server instead of using long polling.
 */
export async function startBot(): Promise<void> {
  const webhookUrl = config.telegram.webhookUrl;

  if (!webhookUrl) {
    logger.warn("TELEGRAM_WEBHOOK_URL is not set, skipping webhook registration");
    return;
  }

  const fullUrl = `${webhookUrl}${WEBHOOK_PATH}`;

  await getBot().api.setWebhook(fullUrl, {
    secret_token: config.telegram.webhookSecret || undefined,
  });

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
