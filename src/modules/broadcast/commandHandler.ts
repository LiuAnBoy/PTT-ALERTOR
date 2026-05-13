import { createLogger } from "../../core/logger";
import { isPatternSafe } from "../subscription/services/regexCache";
import { createChannel, findChannelByPlatformUserId } from "../user/repositories/channelRepository";
import {
  addSubscription,
  countByBoard,
  deleteSubscription,
  getSubscriptions,
  subscriptionExists,
} from "../user/repositories/subscriptionRepository";
import { createUser } from "../user/repositories/userRepository";
import { resolveBoard } from "../user/services/boardValidator";
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
  if (text.startsWith("熱門")) return { command: "boardStats", args: text.slice(2).trim() };
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
    "💡 範例：新增 Gossiping 問卦|爆卦",
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
    "  📊 熱門 [看板] — 看板熱門關鍵字（前 50）",
    "  ❓ 幫助 — 顯示本說明",
    "",
    "📌 AND 複合關鍵字（&）",
    "  使用 & 串接，標題需同時含所有子關鍵字才推播：",
    "  新增 Gamesale 售&ps5",
    "",
    "📌 正則表達式 (Regex)",
    "  所有關鍵字自動以正則比對（純文字也適用）：",
    "  新增 Gossiping 問卦|爆卦      ← OR",
    "  新增 Stock 台積電.*\\d+",
    "  新增 NBA ^(LBJ|Curry)",
    "",
    "⚠️ 注意事項",
    "  • 看板名稱不分大小寫（自動修正）",
    "  • 關鍵字比對不分大小寫",
    "  • 無效的正則會自動視為純文字匹配",
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

  const keyword = parts.slice(1).join(" ").trim();
  if (!keyword) {
    return { reply: "❌ 關鍵字不可為空。" };
  }

  // Validate board exists and resolve canonical name
  const boardName = await resolveBoard(parts[0]);
  if (!boardName) {
    return { reply: `❌ 查無此看板「${parts[0]}」。請確認看板名稱是否正確。` };
  }

  // For AND-mode keywords (containing '&'), validate each part separately;
  // otherwise validate the whole pattern.
  const partsToCheck = keyword.includes("&") ? keyword.split("&").map((p) => p.trim()) : [keyword];

  // Reject malformed AND patterns (empty parts from '&&', leading/trailing '&').
  if (partsToCheck.some((p) => !p)) {
    return {
      reply: "❌ 關鍵字格式錯誤：& 兩側不可為空（例：售&ps5，不接受 售&、&ps5、售&&ps5）。",
    };
  }

  for (const part of partsToCheck) {
    try {
      new RegExp(part);
      if (!isPatternSafe(part)) {
        return { reply: `❌ 關鍵字「${part}」的正則過於複雜或過長，請簡化。` };
      }
    } catch {
      // Invalid regex → will be auto-escaped for literal matching, no error needed
    }
  }

  // Check for duplicate
  const exists = await subscriptionExists(user.id, boardName, keyword);
  if (exists) {
    return { reply: `⚠️ 您已訂閱過「${boardName}」的關鍵字：${keyword}` };
  }

  await addSubscription(user.id, boardName, keyword);
  await addSubscriptionToRedis(user.id, boardName, keyword);
  return { reply: `✅ 成功新增：[${boardName}] — ${keyword}` };
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

  const keyword = parts.slice(1).join(" ");

  // Resolve canonical board name
  const boardName = await resolveBoard(parts[0]);
  if (!boardName) {
    return { reply: `❌ 查無此看板「${parts[0]}」。請確認看板名稱是否正確。` };
  }

  const exists = await subscriptionExists(user.id, boardName, keyword);
  if (!exists) {
    return { reply: `❌ 您尚未訂閱「${boardName}」的關鍵字：${keyword}` };
  }

  await deleteSubscription(user.id, boardName, keyword);
  await removeSubscriptionFromRedis(user.id, boardName, keyword);
  return { reply: `✅ 成功刪除關鍵字：[${boardName}] — ${keyword}` };
}

/**
 * Handle 「熱門 [看板]」— show top subscribed keywords for a board.
 */
export async function executeBoardStats(args: string): Promise<CommandResult> {
  const trimmed = args.trim();
  if (!trimmed) {
    return { reply: "❌ 格式錯誤。用法：熱門 [看板]\n範例：熱門 Gamesale" };
  }

  const boardName = await resolveBoard(trimmed);
  if (!boardName) {
    return { reply: `❌ 查無此看板「${trimmed}」。請確認看板名稱是否正確。` };
  }

  const rows = await countByBoard(boardName, 50);
  if (rows.length === 0) {
    return { reply: `📊 ${boardName} 目前無人訂閱關鍵字。` };
  }

  const padWidth = String(rows[0].subs).length;
  const lines: string[] = [`📊 ${boardName} 熱門關鍵字（前 ${rows.length}）`, ""];
  for (const { keyword, subs } of rows) {
    lines.push(`${String(subs).padStart(padWidth)}  ${keyword}`);
  }

  return { reply: lines.join("\n") };
}

/**
 * Get the user record via channel lookup.
 */
async function getUser(ctx: CommandContext) {
  const channel = await findChannelByPlatformUserId(ctx.platform, ctx.platformUserId);
  return channel?.user ?? null;
}
