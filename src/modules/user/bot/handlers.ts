import type { Context } from "grammy";

import { createLogger } from "../../../core/logger";
import { createChannel, findChannelByPlatformUserId } from "../repositories/channelRepository";
import {
  addSubscription,
  deleteSubscription,
  getSubscriptions,
  subscriptionExists,
} from "../repositories/subscriptionRepository";
import { createUser } from "../repositories/userRepository";
import { boardExists } from "../services/boardValidator";
import { addSubscriptionToRedis, removeSubscriptionFromRedis } from "../services/syncService";

const logger = createLogger("BOT");

/**
 * Handle /start command.
 */
export async function handleStart(ctx: Context) {
  if (!ctx.from) return;

  const platformUserId = ctx.from.id.toString();
  const platformChatId = (ctx.chat?.id ?? ctx.from.id).toString();
  const username = ctx.from.username ?? undefined;

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
    const channel = await findChannelByPlatformUserId("TELEGRAM", platformUserId);

    if (!channel) {
      const user = await createUser();
      await createChannel(user.id, "TELEGRAM", platformUserId, platformChatId, username);
      logger.info(`New user registered: ${username ?? platformUserId}`);
      await ctx.reply(`🎉 註冊成功！歡迎使用 PTT Alertor\n${quickStart}`);
    } else {
      await ctx.reply(`👋 歡迎回來！\n${quickStart}`);
    }
  } catch (err) {
    logger.error(`handleStart failed: ${(err as Error).message}`);
    await ctx.reply("❌ 伺服器錯誤，請稍後再試。");
  }
}

/**
 * Handle 「幫助」command - show usage guide.
 */
async function handleHelp(ctx: Context) {
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

  await ctx.reply(helpText);
}

/**
 * Handle 「清單」command - list all subscriptions.
 */
async function handleList(ctx: Context) {
  const user = await requireUser(ctx);
  if (!user) return;

  const subs = await getSubscriptions(user.id);

  if (subs.length === 0) {
    await ctx.reply("📋 您目前沒有任何訂閱。\n輸入「新增 [看板] [關鍵字]」開始追蹤。");
    return;
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

  await ctx.reply(lines.join("\n"));
}

/**
 * Handle 「新增 [看板] [關鍵字&關鍵字]」command.
 */
async function handleAdd(ctx: Context, args: string) {
  const user = await requireUser(ctx);
  if (!user) return;

  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply("❌ 格式錯誤。用法：新增 [看板] [關鍵字]\n範例：新增 Gossiping 問卦");
    return;
  }

  const boardName = parts[0];
  const keywordStr = parts.slice(1).join(" ");

  // Validate board exists
  const valid = await boardExists(boardName);
  if (!valid) {
    await ctx.reply(`❌ 查無此看板「${boardName}」。請確認看板名稱（區分大小寫）。`);
    return;
  }

  // Split keywords by &
  const keywords = keywordStr
    .split("&")
    .map((k) => k.trim())
    .filter(Boolean);

  const results: string[] = [];
  for (const keyword of keywords) {
    // Validate regex syntax
    if (keyword.startsWith("regexp:")) {
      const pattern = keyword.slice(7);
      try {
        new RegExp(pattern);
      } catch {
        results.push(`❌ 關鍵字「${keyword}」的語法有誤，請檢查。`);
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

  await ctx.reply(results.join("\n"));
}

/**
 * Handle 「刪除 [看板] [關鍵字]」command.
 */
async function handleDelete(ctx: Context, args: string) {
  const user = await requireUser(ctx);
  if (!user) return;

  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply("❌ 格式錯誤。用法：刪除 [看板] [關鍵字]\n範例：刪除 Gossiping 問卦");
    return;
  }

  const boardName = parts[0];
  const keyword = parts.slice(1).join(" ");

  const exists = await subscriptionExists(user.id, boardName, keyword);
  if (!exists) {
    await ctx.reply(`❌ 您尚未訂閱「${boardName}」的關鍵字：${keyword}`);
    return;
  }

  await deleteSubscription(user.id, boardName, keyword);
  await removeSubscriptionFromRedis(user.id, boardName, keyword);
  await ctx.reply(`✅ 成功刪除關鍵字：[${boardName}] — ${keyword}`);
}

/**
 * Route incoming text messages to the appropriate handler.
 */
export async function handleText(ctx: Context) {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  if (text === "幫助") return handleHelp(ctx);
  if (text === "清單") return handleList(ctx);
  if (text.startsWith("新增")) return handleAdd(ctx, text.slice(2).trim());
  if (text.startsWith("刪除")) return handleDelete(ctx, text.slice(2).trim());
}

/**
 * Get the user record from Telegram context via Channel lookup.
 */
async function getUser(ctx: Context) {
  if (!ctx.from) return null;
  const channel = await findChannelByPlatformUserId("TELEGRAM", ctx.from.id.toString());
  return channel?.user ?? null;
}

/**
 * Get the user record, replying with a prompt to /start if not found.
 */
async function requireUser(ctx: Context) {
  const user = await getUser(ctx);
  if (!user) {
    await ctx.reply("❌ 請先輸入 /start 來開始使用。");
    return null;
  }
  return user;
}
