import { config } from "../../core/config";
import { encryptSecret } from "../../core/crypto";
import { createLogger } from "../../core/logger";
import { deletePttAccount } from "../mail/repositories/pttAccountRepository";
import { enqueueVerifyJob } from "../mail/services/mailService";
import { isPatternSafe } from "../subscription/services/regexCache";
import { createChannel, findChannelByPlatformUserId } from "../user/repositories/channelRepository";
import {
  addSubscription,
  countByBoard,
  deleteSubscription,
  getSubscriptionById,
  getSubscriptions,
  setReplyContent,
  setReplyIncludeOriginal,
  subscriptionExists,
} from "../user/repositories/subscriptionRepository";
import { createUser } from "../user/repositories/userRepository";
import { resolveBoard } from "../user/services/boardValidator";
import { addSubscriptionToRedis, removeSubscriptionFromRedis } from "../user/services/syncService";
import { clearPending, getPending, setPending } from "./pendingState";
import type { ButtonRows, CommandContext, CommandResult } from "./types";

const logger = createLogger("COMMAND");

/** Longest reply text a subscription may carry. */
export const MAX_REPLY_LENGTH = 2000;
/** Longest button label shown for a subscription in the list. */
const MAX_BUTTON_LABEL = 40;
/** Telegram allows at most 100 buttons in one inline keyboard. */
const MAX_LIST_BUTTONS = 100;
/** Longest password accepted (PTT only reads the first 8 characters). */
const MAX_PASSWORD_LENGTH = 64;
/** The word that abandons the bind flow at the ID step. */
const BIND_CANCEL = "取消";
const RESERVED_PTT_IDS = new Set(["guest", "new"]);

/** Shown when a mail command is used while the feature is switched off. */
export const MAIL_OFF_TEXT = "❌ 寄信功能目前未啟用。";

/** Shown at the start of 綁定PTT; every statement is true of how the password is handled. */
export const PTT_DISCLAIMER = [
  "🔐 PTT 帳號密碼聲明",
  "• 密碼以 AES-256-GCM 加密後儲存，只在寄信的當下於記憶體中解密，不會寫入記錄檔。",
  "• 伺服器管理者在技術上仍然可以解密這份密碼。",
  "• 請使用專門寄信的 PTT 副帳號，不要使用你的主要帳號。",
  "• 輸入「解除PTT」會立刻刪除已儲存的帳號與密碼。",
].join("\n");

/** Added to the reply when the password message could not be deleted. */
export const PASSWORD_DELETE_WARNING = "⚠️ 無法自動刪除你剛才傳送的密碼訊息，請立即手動刪除它。";

/** Result of an inline-button action. */
export interface CallbackResult extends CommandResult {
  /** True to edit the message the button sits under instead of sending a new one */
  edit?: boolean;
  /** Short text for the button-press toast */
  toast?: string;
}

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
  if (/^綁定ptt$/i.test(text)) return { command: "bindPtt", args: "" };
  if (/^解除ptt$/i.test(text)) return { command: "unbindPtt", args: "" };
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
    "📌 PTT 寄信（回信給作者）",
    "  🔑 綁定PTT — 綁定你的 PTT 副帳號（只能在私訊使用）",
    "  🔓 解除PTT — 刪除已儲存的 PTT 帳號與密碼",
    "  ✉️ 設定回信：新增訂閱後按「設定回信內容」，或在「清單」按訂閱旁的按鈕；",
    "     有回信內容的訂閱，推播時會出現寄信按鈕",
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

  const buttons: ButtonRows | undefined = config.mail.enabled
    ? subs.slice(0, MAX_LIST_BUTTONS).map((sub) => [
        {
          text: Array.from(`⚙️ ${sub.board} · ${sub.keyword}`).slice(0, MAX_BUTTON_LABEL).join(""),
          action: subAction(sub.id, "open"),
        },
      ])
    : undefined;

  return { reply: lines.join("\n"), buttons };
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

  const created = await addSubscription(user.id, boardName, keyword);
  await addSubscriptionToRedis(user.id, boardName, keyword);
  return {
    reply: `✅ 成功新增：[${boardName}] — ${keyword}`,
    buttons: config.mail.enabled ? cardButtons(created) : undefined,
  };
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

// ─── PTT account binding ────────────────────────────────────────────────────

/**
 * Check the shape of a PTT ID: a letter then letters or digits, 2-12 characters, not guest/new.
 * @param id - The text the user sent.
 * @returns True when it can be a real account name.
 */
function isValidPttId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(id) && !RESERVED_PTT_IDS.has(id.toLowerCase());
}

/**
 * Handle 「綁定PTT」— show the disclaimer and ask for the PTT ID.
 * @param ctx - The command context; binding works only in a private chat.
 */
export async function executeBindStart(ctx: CommandContext): Promise<CommandResult> {
  if (!config.mail.enabled) return { reply: MAIL_OFF_TEXT };
  if (!ctx.isPrivate) {
    return { reply: "❌ 為了保護密碼，請在與機器人的私訊中使用「綁定PTT」。" };
  }
  const user = await getUser(ctx);
  if (!user) return { reply: "❌ 請先輸入 /start 來開始使用。" };

  await setPending(ctx.platformUserId, { step: "bindId" });
  return { reply: `${PTT_DISCLAIMER}\n\n請輸入你的 PTT 帳號（ID）：` };
}

/**
 * Handle 「解除PTT」— delete the stored account.
 * @param ctx - The command context.
 */
export async function executeUnbind(ctx: CommandContext): Promise<CommandResult> {
  const user = await getUser(ctx);
  if (!user) return { reply: "❌ 請先輸入 /start 來開始使用。" };

  const deleted = await deletePttAccount(user.id);
  return {
    reply: deleted ? "✅ 已刪除你儲存的 PTT 帳號與密碼。" : "ℹ️ 你目前沒有綁定 PTT 帳號。",
  };
}

/**
 * Take the PTT password: delete the message, encrypt it and queue the verification.
 * The terminal client is never called here, and the plaintext never leaves this function.
 * @param ctx - The command context whose untrimmed text is the password.
 * @param pttId - The PTT ID given in the previous step.
 */
async function receivePassword(ctx: CommandContext, pttId: string): Promise<CommandResult> {
  let deleteFailed = false;
  try {
    if (!ctx.deleteInputMessage) throw new Error("no delete support");
    await ctx.deleteInputMessage();
  } catch {
    deleteFailed = true;
  }
  const warn = (reply: string): CommandResult => ({
    reply: deleteFailed ? `${reply}\n${PASSWORD_DELETE_WARNING}` : reply,
  });

  if (!config.mail.enabled) return warn(MAIL_OFF_TEXT);
  if (!ctx.isPrivate) return warn("❌ 請在私訊中綁定 PTT。");
  const password = ctx.rawText ?? ctx.text;
  if (password.length > MAX_PASSWORD_LENGTH) {
    return warn("❌ 密碼長度不正確，請重新輸入「綁定PTT」。");
  }
  const user = await getUser(ctx);
  if (!user) return warn("❌ 請先輸入 /start 來開始使用。");

  try {
    const passwordEnc = encryptSecret(password, config.mail.encryptKey);
    await enqueueVerifyJob({
      userId: user.id,
      chatId: ctx.platformChatId,
      pttId,
      passwordEnc,
    });
  } catch (err) {
    logger.error(`Bind verification could not be queued: ${(err as Error).name}`);
    return warn("❌ 伺服器錯誤，請稍後重新輸入「綁定PTT」。");
  }
  return warn("⏳ 驗證中…");
}

// ─── Per-subscription reply settings ────────────────────────────────────────

type SubscriptionRecord = NonNullable<Awaited<ReturnType<typeof getSubscriptionById>>>;
type SubAction = "open" | "reply" | "orig" | "clear";

/**
 * Build the callback payload of a settings button.
 * @param subscriptionId - The subscription UUID.
 * @param action - The settings action.
 * @returns `sub:<id>:<action>`.
 */
function subAction(subscriptionId: string, action: SubAction): string {
  return `sub:${subscriptionId}:${action}`;
}

/**
 * Buttons of the settings card of one subscription.
 * @param sub - The subscription.
 */
function cardButtons(sub: Pick<SubscriptionRecord, "id" | "replyIncludeOriginal">): ButtonRows {
  return [
    [{ text: "✏️ 設定回信內容", action: subAction(sub.id, "reply") }],
    [
      {
        text: `📎 附原文：${sub.replyIncludeOriginal ? "開" : "關"}`,
        action: subAction(sub.id, "orig"),
      },
      { text: "🗑 清除回信", action: subAction(sub.id, "clear") },
    ],
  ];
}

/**
 * Render the settings card of one subscription.
 * @param sub - The subscription.
 * @param notice - Optional line shown above the card.
 */
function renderCard(sub: SubscriptionRecord, notice?: string): CallbackResult {
  const lines = [
    ...(notice ? [notice, ""] : []),
    `⚙️ 回信設定`,
    `看板：${sub.board}`,
    `關鍵字：${sub.keyword}`,
    `回信內容：${sub.replyContent?.trim() ? `\n${sub.replyContent}` : "未設定"}`,
    `附原文：${sub.replyIncludeOriginal ? "開" : "關"}`,
  ];
  return { reply: lines.join("\n"), buttons: cardButtons(sub), edit: true };
}

/**
 * Load a subscription only when it belongs to the user who is acting.
 * @param ctx - The command context identifying the actor.
 * @param subscriptionId - The subscription UUID from a button or pending state.
 * @returns The subscription, or null when missing or owned by someone else.
 */
async function loadOwnedSubscription(
  ctx: CommandContext,
  subscriptionId: string,
): Promise<SubscriptionRecord | null> {
  const user = await getUser(ctx);
  if (!user) return null;
  const sub = await getSubscriptionById(subscriptionId);
  return sub && sub.userId === user.id ? sub : null;
}

const SUB_NOT_FOUND: CallbackResult = {
  reply: "❌ 找不到這個訂閱。",
  toast: "找不到這個訂閱",
};

/**
 * Handle a `sub:<id>:<action>` button press from the presser's own subscriptions only.
 * @param ctx - The command context of the presser.
 * @param subscriptionId - The subscription UUID.
 * @param action - open, reply, orig or clear.
 * @returns What to show; a refused action returns a not-found text.
 */
export async function executeSubAction(
  ctx: CommandContext,
  subscriptionId: string,
  action: string,
): Promise<CallbackResult> {
  if (!config.mail.enabled) return { reply: MAIL_OFF_TEXT, toast: "寄信功能未啟用" };

  const sub = await loadOwnedSubscription(ctx, subscriptionId);
  if (!sub) return SUB_NOT_FOUND;

  switch (action) {
    case "open":
      return { ...renderCard(sub), edit: false };
    case "reply":
      await setPending(ctx.platformUserId, { step: "replyText", subscriptionId: sub.id });
      return {
        reply: `✏️ 請輸入要寄給作者的回信內容（最多 ${MAX_REPLY_LENGTH} 字）：\n[${sub.board}] ${sub.keyword}`,
      };
    case "orig": {
      const updated = await setReplyIncludeOriginal(sub.id, !sub.replyIncludeOriginal);
      return renderCard(updated);
    }
    case "clear": {
      const updated = await setReplyContent(sub.id, null);
      return renderCard(updated, "🗑 已清除回信內容");
    }
    default:
      return { reply: "❌ 無法辨識的操作。" };
  }
}

// ─── Pending input ──────────────────────────────────────────────────────────

/**
 * Consume the message only when the user is at a bind step. Platforms call this before their
 * own slash commands (which do not go through the text handler), so a password that starts
 * with "/" is still taken as the password and deleted.
 * @param ctx - The command context of the incoming text.
 * @returns The bind step's reply, or null when no bind step is pending.
 */
export async function handleBindInput(ctx: CommandContext): Promise<CommandResult | null> {
  const pending = await getPending(ctx.platformUserId);
  if (pending?.step !== "bindId" && pending?.step !== "bindPassword") return null;
  return handlePending(ctx);
}

/**
 * Consume the user's message when the bot is waiting for one (bind ID, password, reply text).
 * The bind steps consume every text before any command parsing: at the password step the text
 * is the password whatever it looks like, and at the ID step it is an ID, a validation error,
 * or the exact word 取消 (the wait also expires on its own). At the reply-text step a
 * recognised command clears the wait and returns null so it runs normally.
 * @param ctx - The command context of the incoming text.
 * @returns The reply, or null when nothing was pending or the text is a command.
 */
export async function handlePending(ctx: CommandContext): Promise<CommandResult | null> {
  const pending = await getPending(ctx.platformUserId);
  if (!pending) return null;

  if (pending.step === "bindPassword") {
    await clearPending(ctx.platformUserId);
    // Outside a private chat receivePassword still deletes the message, then refuses.
    return receivePassword(ctx, pending.pttId);
  }
  if (pending.step === "bindId") {
    if (!ctx.isPrivate) {
      await clearPending(ctx.platformUserId);
      return { reply: "❌ 請在私訊中綁定 PTT。" };
    }
    if (ctx.text === BIND_CANCEL) {
      await clearPending(ctx.platformUserId);
      return { reply: "已取消綁定 PTT。" };
    }
    if (!isValidPttId(ctx.text)) {
      return {
        reply: `❌ PTT 帳號格式不正確（英文字母開頭，2 到 12 個英數字，不可為 guest 或 new）。請重新輸入，或輸入「${BIND_CANCEL}」放棄：`,
      };
    }
    await setPending(ctx.platformUserId, { step: "bindPassword", pttId: ctx.text });
    return {
      reply: `請輸入 ${ctx.text} 的密碼。我會在收到後刪除該訊息。你的下一則訊息一律視為密碼；5 分鐘內沒有輸入會自動取消。`,
    };
  }

  if (parseCommand(ctx.text)) {
    await clearPending(ctx.platformUserId);
    return null;
  }

  switch (pending.step) {
    case "replyText": {
      if (ctx.text.length > MAX_REPLY_LENGTH) {
        return { reply: `❌ 回信內容太長（上限 ${MAX_REPLY_LENGTH} 字），請縮短後重新輸入：` };
      }
      await clearPending(ctx.platformUserId);
      if (!config.mail.enabled) return { reply: MAIL_OFF_TEXT };
      const sub = await loadOwnedSubscription(ctx, pending.subscriptionId);
      if (!sub) return SUB_NOT_FOUND;
      const updated = await setReplyContent(sub.id, ctx.text);
      return renderCard(updated, "✅ 已儲存回信內容");
    }
    default:
      await clearPending(ctx.platformUserId);
      return null;
  }
}

/**
 * Resolve the user behind a platform account via its channel; the one lookup other modules
 * use instead of reaching into the channel repository.
 * @param ctx - The command context identifying the platform user.
 * @returns The user record, or null when the platform user never sent /start.
 */
export async function getUser(ctx: CommandContext) {
  const channel = await findChannelByPlatformUserId(ctx.platform, ctx.platformUserId);
  return channel?.user ?? null;
}
