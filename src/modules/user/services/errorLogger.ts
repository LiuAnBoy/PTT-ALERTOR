import type { LogLevel } from "@prisma/client";

import { config } from "../../../core/config";
import { createLogger } from "../../../core/logger";
import { getPrisma } from "../../../core/prisma";
import { getAdapter } from "../../broadcast/registry";

const logger = createLogger("BOT");

const ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Track last alert time by error key to implement cooldown. */
const lastAlertMap = new Map<string, number>();

/**
 * Log an error to crawler_logs and optionally push alert to admin.
 * FATAL: always push immediately.
 * ERROR: push with 5-minute cooldown per module+message combo.
 *
 * @param level - Log severity level.
 * @param module - Module tag where the error occurred.
 * @param message - Error message summary.
 * @param detail - Optional error detail (stack trace, context, etc).
 */
export async function logError(
  level: LogLevel,
  module: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  // Write to database
  await getPrisma().crawlerLog.create({
    data: { level, module, message, detail: detail ?? undefined },
  });

  // Push alert to admin
  if (!config.telegram.adminChatId) return;

  if (level === "FATAL") {
    await sendAlert(`🚨 [FATAL] ${module} | ${message}`);
  } else if (level === "ERROR") {
    const key = `${module}:${message}`;
    const now = Date.now();
    const last = lastAlertMap.get(key) ?? 0;

    if (now - last >= ERROR_COOLDOWN_MS) {
      lastAlertMap.set(key, now);
      await sendAlert(`⚠️ [ERROR] ${module} | ${message}`);
    }
  }
}

/**
 * Send an alert message to the admin Telegram chat.
 */
async function sendAlert(text: string): Promise<void> {
  if (!config.telegram.adminChatId) return;

  try {
    await getAdapter("TELEGRAM").sendAlert(config.telegram.adminChatId, text);
  } catch (err) {
    logger.error(`Failed to send admin alert: ${(err as Error).message}`);
  }
}

/**
 * Get recent error logs from the last 24 hours.
 * @returns Array of crawler log records.
 */
export async function getRecentErrors() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return getPrisma().crawlerLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/**
 * Mark all unnotified errors as notified.
 * @returns Number of records updated.
 */
export async function clearErrors(): Promise<number> {
  const result = await getPrisma().crawlerLog.updateMany({
    where: { notified: false },
    data: { notified: true },
  });
  return result.count;
}
