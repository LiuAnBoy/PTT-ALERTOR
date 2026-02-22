import type { Context } from "grammy";

import { config } from "../../../core/config";
import { clearErrors, getRecentErrors } from "../services/errorLogger";

/**
 * Check if the sender is the admin.
 */
function isAdmin(ctx: Context): boolean {
  if (!config.telegram.adminChatId || !ctx.from) return false;
  return String(ctx.from.id) === config.telegram.adminChatId;
}

/**
 * Handle /errors command - show recent error logs (admin only).
 */
export async function handleErrors(ctx: Context) {
  if (!isAdmin(ctx)) return;

  const text = ctx.message?.text?.trim() ?? "";

  // /errors clear
  if (text.includes("clear")) {
    const count = await clearErrors();
    await ctx.reply(`✅ 已標記 ${count} 筆錯誤為已處理。`);
    return;
  }

  // /errors - list recent
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

  // Telegram message limit: 4096 chars
  let message = `📋 最近 24 小時錯誤記錄（${logs.length} 筆）：\n\n${lines.join("\n")}`;
  if (message.length > 4096) {
    message = message.slice(0, 4093) + "...";
  }

  await ctx.reply(message);
}
