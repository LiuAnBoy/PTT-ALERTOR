import { createLogger } from "../../core/logger";
import { isPatternSafe } from "../subscription/services/regexCache";
import { createChannel, findChannelByPlatformUserId } from "../user/repositories/channelRepository";
import {
  addSubscription,
  deleteSubscription,
  getSubscriptions,
  subscriptionExists,
} from "../user/repositories/subscriptionRepository";
import { createUser } from "../user/repositories/userRepository";
import { boardExists } from "../user/services/boardValidator";
import { addSubscriptionToRedis, removeSubscriptionFromRedis } from "../user/services/syncService";
import type { CommandContext, CommandResult } from "./types";

const logger = createLogger("COMMAND");

/**
 * Parse a text message into a command and its arguments.
 * @param text - The raw text message.
 * @returns Parsed command and args, or null if not recognized.
 */
export function parseCommand(text: string): { command: string; args: string } | null {
  if (text === "幫助") return { command: "help", args: "" };
  if (text === "清單") return { command: "list", args: "" };
  if (text.startsWith("新增")) return { command: "add", args: text.slice(2).trim() };
  if (text.startsWith("刪除")) return { command: "delete", args: text.slice(2).trim() };
  return null;
}

/**
 * Handle /start — register a new user or welcome back.
 */
export async function executeStart(ctx: CommandContext): Promise<CommandResult> {
  const quickStart = [
    "",
    "📌 快速開始：",
    "➕ 新增 [看板] [關鍵字] — 新增訂閱",
    "➖ 刪除 [看板] [關鍵字] — 刪除訂閱",
    "📋 清單 — 查看目前訂閱",
    "❓ 幫助 — 詳細使用說明",
    "",
    "💡 範例：新增 Gossiping 問卦",
  ].join("\n");

  try {
    const channel = await findChannelByPlatformUserId(ctx.platform, ctx.platformUserId);

    if (!channel) {
      const user = await createUser(ctx.displayName);
      await createChannel(
        user.id,
        ctx.platform,
        ctx.platformUserId,
        ctx.platformChatId,
        ctx.rawData,
      );
      logger.info(`New user registered: ${ctx.displayName ?? ctx.platformUserId}`);
      return { reply: `🎉 註冊成功！歡迎使用 PTT Alertor\n${quickStart}` };
    }

    return { reply: `👋 歡迎回來！\n${quickStart}` };
  } catch (err) {
    logger.error(`executeStart failed: ${(err as Error).message}`);
    return { reply: "❌ 伺服器錯誤，請稍後再試。" };
  }
}

/**
 * Handle 「幫助」— show usage guide.
 */
export function executeHelp(): CommandResult {
  const helpText = [
    "📖 PTT Alertor 詳細使用指南",
    "",
    "📌 基本指令",
    "  ➕ 新增 [看板] [關鍵字] — 新增訂閱",
    "  ➖ 刪除 [看板] [關鍵字] — 刪除訂閱",
    "  📋 清單 — 查看目前所有訂閱",
    "  ❓ 幫助 — 顯示本說明",
    "",
    "📌 多關鍵字訂閱",
    "  使用 & 同時新增多個關鍵字：",
    "  新增 Gossiping 問卦&爆卦&閒聊",
    "",
    "📌 正則表達式 (Regex)",
    "  使用 regexp: 前綴啟用正則比對：",
    "  新增 Gossiping regexp:問卦|爆卦",
    "  新增 Stock regexp:台積電.*\\d+",
    "  新增 NBA regexp:^(LBJ|Curry)",
    "",
    "⚠️ 注意事項",
    "  • 看板名稱區分大小寫（如 Gossiping, Stock）",
    "  • 關鍵字比對不分大小寫（純文字模式）",
    "  • Regex 模式請確認語法正確",
  ].join("\n");

  return { reply: helpText };
}

/**
 * Handle 「清單」— list all subscriptions.
 */
export async function executeList(ctx: CommandContext): Promise<CommandResult> {
  const user = await getUser(ctx);
  if (!user) return { reply: "❌ 請先輸入 /start 來開始使用。" };

  const subs = await getSubscriptions(user.id);

  if (subs.length === 0) {
    return { reply: "📋 您目前沒有任何訂閱。\n輸入「新增 [看板] [關鍵字]」開始追蹤。" };
  }

  // Group by board
  const grouped = new Map<string, string[]>();
  for (const sub of subs) {
    const list = grouped.get(sub.board) ?? [];
    list.push(sub.keyword);
    grouped.set(sub.board, list);
  }

  const lines: string[] = ["📋 您的訂閱清單：\n"];
  for (const [board, keywords] of grouped) {
    lines.push(`📌 ${board}`);
    for (const kw of keywords) {
      lines.push(`   • ${kw}`);
    }
  }

  return { reply: lines.join("\n") };
}

/**
 * Handle 「新增 [看板] [關鍵字&關鍵字]」command.
 */
export async function executeAdd(ctx: CommandContext, args: string): Promise<CommandResult> {
  const user = await getUser(ctx);
  if (!user) return { reply: "❌ 請先輸入 /start 來開始使用。" };

  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    return { reply: "❌ 格式錯誤。用法：新增 [看板] [關鍵字]\n範例：新增 Gossiping 問卦" };
  }

  const boardName = parts[0];
  const keywordStr = parts.slice(1).join(" ");

  // Validate board exists
  const valid = await boardExists(boardName);
  if (!valid) {
    return { reply: `❌ 查無此看板「${boardName}」。請確認看板名稱（區分大小寫）。` };
  }

  // Split keywords by &
  const keywords = keywordStr
    .split("&")
    .map((k) => k.trim())
    .filter(Boolean);

  const results: string[] = [];
  for (const keyword of keywords) {
    // Validate regex syntax and safety
    if (keyword.startsWith("regexp:")) {
      const pattern = keyword.slice(7);
      try {
        new RegExp(pattern);
      } catch {
        results.push(`❌ 關鍵字「${keyword}」的語法有誤，請檢查。`);
        continue;
      }
      if (!isPatternSafe(pattern)) {
        results.push(`❌ 關鍵字「${keyword}」的正則過於複雜或過長，請簡化。`);
        continue;
      }
    }

    // Check for duplicate
    const exists = await subscriptionExists(user.id, boardName, keyword);
    if (exists) {
      results.push(`⚠️ 您已訂閱過「${boardName}」的關鍵字：${keyword}`);
      continue;
    }

    await addSubscription(user.id, boardName, keyword);
    await addSubscriptionToRedis(user.id, boardName, keyword);
    results.push(`✅ 成功新增：[${boardName}] — ${keyword}`);
  }

  return { reply: results.join("\n") };
}

/**
 * Handle 「刪除 [看板] [關鍵字]」command.
 */
export async function executeDelete(ctx: CommandContext, args: string): Promise<CommandResult> {
  const user = await getUser(ctx);
  if (!user) return { reply: "❌ 請先輸入 /start 來開始使用。" };

  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    return { reply: "❌ 格式錯誤。用法：刪除 [看板] [關鍵字]\n範例：刪除 Gossiping 問卦" };
  }

  const boardName = parts[0];
  const keyword = parts.slice(1).join(" ");

  const exists = await subscriptionExists(user.id, boardName, keyword);
  if (!exists) {
    return { reply: `❌ 您尚未訂閱「${boardName}」的關鍵字：${keyword}` };
  }

  await deleteSubscription(user.id, boardName, keyword);
  await removeSubscriptionFromRedis(user.id, boardName, keyword);
  return { reply: `✅ 成功刪除關鍵字：[${boardName}] — ${keyword}` };
}

/**
 * Get the user record via channel lookup.
 */
async function getUser(ctx: CommandContext) {
  const channel = await findChannelByPlatformUserId(ctx.platform, ctx.platformUserId);
  return channel?.user ?? null;
}
