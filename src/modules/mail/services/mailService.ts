import type { MailRequest, MailRequestStatus, Subscription } from "@prisma/client";

import { config } from "../../../core/config";
import { decryptSecret } from "../../../core/crypto";
import { createLogger } from "../../../core/logger";
import { getArticleForMail } from "../../board/repositories/articleRepository";
import { ARTICLE_DELETED, fetchDetail } from "../../board/services/detailFetcher";
import { getAdapter } from "../../broadcast/registry";
import type { ButtonRows, MessageRef, NotificationPayload } from "../../broadcast/types";
import { findSubscription } from "../../user/repositories/subscriptionRepository";
import * as mailRequests from "../repositories/mailRequestRepository";
import { MAX_MAIL_ATTEMPTS } from "../repositories/mailRequestRepository";
import * as pttAccounts from "../repositories/pttAccountRepository";
import { mailQueue, SEND_JOB, VERIFY_JOB, type VerifyJobData } from "../workers/mailQueue";
import { holdLogins, reserveLogin } from "./loginGate";
import { PttError, sendPttMail, verifyPttLogin } from "./pttTerminal";

const logger = createLogger("MAIL");

export type { VerifyJobData } from "../workers/mailQueue";

// ---------------------------------------------------------------------------
// User-facing texts (Traditional Chinese). Every message the user sees about mail lives here.
// ---------------------------------------------------------------------------

/** Reasons stored in `MailRequest.error` and shown to the user. */
const FAIL_REASON = {
  disabled: "寄信功能已關閉",
  noSubscription: "找不到對應的訂閱或信件內容",
  noAccount: "尚未綁定 PTT 帳號",
  accountInvalid: "PTT 密碼錯誤",
  decrypt: "無法讀取已儲存的帳密",
  twoFactor: "此帳號啟用兩步驟驗證，目前不支援",
  noSuchUser: "找不到收件的 PTT 使用者",
  busy: "PTT 目前忙碌",
  timeout: "連線逾時",
  connect: "無法連線到 PTT",
  secure: "PTT 要求安全連線，無法登入",
  draft: "這個 PTT 帳號有未完成的文章草稿，請先登入 PTT 一次，完成或放棄該草稿後再試",
  sessions: "這個 PTT 帳號同時登入的連線太多（3 個以上），為了不踢掉你的其他連線，請先登出其中幾個",
  throttled:
    "PTT 偵測到這個帳號登入太頻繁而暫停登入約 5 分鐘，機器人 10 分鐘內不會再用這個帳號登入",
  generic: "寄信失敗",
} as const;

const REBIND_HINT = "請重新「綁定PTT」更新密碼。";
const ORIGINAL_MISSING_NOTE = "（原文已刪除或無法取得，未附上引文）";

/** Texts reported to the user; also used by the Telegram layer. */
export const MAIL_TEXT = {
  sending: "⏳ 寄送中…",
  sent: (author: string, title: string, originalMissing: boolean) =>
    `✅ 已寄給 ${author}\n《${title}》${originalMissing ? `\n${ORIGINAL_MISSING_NOTE}` : ""}`,
  failed: (reason: string, hint?: string) => `❌ 寄信失敗：${reason}${hint ? `\n${hint}` : ""}`,
  failedRetry: (reason: string) => `❌ 寄信失敗：${reason}\n信件沒有寄出，可以再按一次重試。`,
  unknown: (author: string) =>
    `⚠️ 無法確認信件是否已寄給 ${author}，請到 PTT 信箱的寄件備份確認。為避免重複寄信，不會自動重試。`,
  verifyOk: (pttId: string) => `✅ 已綁定 PTT 帳號 ${pttId}`,
  verifyWrongPassword: `❌ PTT 登入失敗：帳號或密碼錯誤。${REBIND_HINT}`,
  verifyTwoFactor: `❌ ${FAIL_REASON.twoFactor}。`,
  verifyFailed: (reason: string) => `❌ 無法驗證 PTT 帳號：${reason}，請稍後再試。`,
  verifyDraft: `❌ 無法驗證 PTT 帳號：${FAIL_REASON.draft}，再重新「綁定PTT」。`,
} as const;

/**
 * Short user-facing sentence for a refused tap, for the Telegram layer to show.
 * @param outcome - The result of {@link requestMail} other than `queued`.
 * @returns The text to answer with.
 */
export function describeRequestOutcome(outcome: Exclude<RequestMailOutcome, { kind: "queued" }>) {
  switch (outcome.kind) {
    case "disabled":
      return FAIL_REASON.disabled;
    case "not_found":
      return "找不到這封信的請求";
    case "not_owner":
      return "這個按鈕不是給你的";
    case "no_account":
      return "請先「綁定PTT」帳號再寄信";
    case "account_invalid":
      return `PTT 密碼錯誤。${REBIND_HINT}`;
    case "attempts_exhausted":
      return `這封信已嘗試 ${outcome.max} 次，不再重試`;
    case "cap_reached":
      return `今天寄信已達上限（${outcome.limit} 封）`;
    case "enqueue_failed":
      return "排隊失敗，請稍後再按一次";
    case "not_claimable":
      return STATUS_TEXT[outcome.status];
  }
}

const STATUS_TEXT: Record<MailRequestStatus, string> = {
  OFFERED: "尚未寄出",
  QUEUED: "已在排隊寄送中",
  SENDING: "正在寄送中",
  SENT: "已經寄出了",
  FAILED: "上次寄送失敗",
  UNKNOWN: "無法確認是否寄出，請到 PTT 信箱確認",
};

// ---------------------------------------------------------------------------
// Building the mail
// ---------------------------------------------------------------------------

/** A mail ready for `sendPttMail`. */
export interface BuiltMail {
  to: string;
  subject: string;
  body: string;
  /** True when the user asked for the original but its text was not available. */
  originalMissing: boolean;
}

/**
 * Build the subject and body of the mail.
 * The body is the reply text; with `replyIncludeOriginal` and an available article text it is
 * followed by a blank line, `※ 引述《author》之銘言：` and every article line prefixed `: `.
 * Truncation and encoding of the subject happen in the terminal client.
 * @param request - The mail request (author and title).
 * @param subscription - The subscription holding the reply text and quote flag.
 * @param articleText - The article text, or null when unavailable.
 * @returns The mail and whether the requested quote had to be left out.
 */
export function buildMail(
  request: Pick<MailRequest, "author" | "title">,
  subscription: Pick<Subscription, "replyContent" | "replyIncludeOriginal">,
  articleText: string | null,
): BuiltMail {
  let body = subscription.replyContent ?? "";
  let originalMissing = false;
  if (subscription.replyIncludeOriginal) {
    const text = articleText?.replace(/\s+$/, "") ?? "";
    if (text === "") {
      originalMissing = true;
    } else {
      const quoted = text
        .split(/\r?\n/)
        .map((line) => `: ${line}`)
        .join("\n");
      body = `${body}\n\n※ 引述《${request.author}》之銘言：\n${quoted}`;
    }
  }
  return { to: request.author, subject: `Re: ${request.title}`, body, originalMissing };
}

/**
 * Article text for quoting: the stored content, else a fresh fetch.
 * @param code - The article code.
 * @returns The text, or null when the article is deleted or cannot be read.
 */
async function loadArticleText(code: string): Promise<string | null> {
  const row = await getArticleForMail(code);
  if (!row) return null;
  if (row.content) return row.content;
  const detail = await fetchDetail(row.link);
  if (detail === ARTICLE_DELETED || detail === null) return null;
  return detail.content || null;
}

// ---------------------------------------------------------------------------
// Offering a mail button
// ---------------------------------------------------------------------------

/** Result of {@link checkEligibility}. */
export type Eligibility =
  | { eligible: true; author: string; subscription: Subscription }
  | { eligible: false; reason: string };

/**
 * Decide whether a notification may carry a mail button: mail enabled, the subscription
 * (userId + board + keyword) has a non-empty reply text, an account is bound and not invalid,
 * and the article has an author.
 * @param payload - The notification about to be sent.
 * @returns Eligibility with the reason when not eligible.
 */
export async function checkEligibility(payload: NotificationPayload): Promise<Eligibility> {
  if (!config.mail.enabled) return { eligible: false, reason: "disabled" };
  if (!payload.author) return { eligible: false, reason: "no_author" };
  const subscription = await findSubscription(payload.userId, payload.board, payload.keyword);
  if (!subscription?.replyContent?.trim()) return { eligible: false, reason: "no_reply_content" };
  const account = await pttAccounts.getPttAccount(payload.userId);
  if (!account) return { eligible: false, reason: "no_account" };
  if (account.invalidAt) return { eligible: false, reason: "account_invalid" };
  return { eligible: true, author: payload.author, subscription };
}

/**
 * Record an offer for a notification when it is eligible.
 * @param payload - The notification about to be sent.
 * @returns The MailRequest id (the button id), or null when no button should be shown: not
 *   eligible, the article's request belongs to another keyword (one request serves one
 *   article, so only the notification of the keyword it was made for gets the button), or the
 *   request already moved past OFFERED (or FAILED with attempts exhausted).
 */
export async function offerMail(payload: NotificationPayload): Promise<string | null> {
  const eligibility = await checkEligibility(payload);
  if (!eligibility.eligible) return null;
  const row = await mailRequests.upsertOffer({
    userId: payload.userId,
    board: payload.board,
    articleCode: payload.articleCode,
    author: eligibility.author,
    title: payload.title,
    keyword: payload.keyword,
  });
  if (row.keyword !== payload.keyword) return null;
  if (row.status === "OFFERED") return row.id;
  if (row.status === "FAILED" && row.attempts < MAX_MAIL_ATTEMPTS) return row.id;
  return null;
}

/**
 * Remember the message that carries a request's button, so the result can be reported on it.
 * @param requestId - The MailRequest id.
 * @param ref - The message holding the button.
 */
export async function recordNotificationMessage(requestId: string, ref: MessageRef): Promise<void> {
  await mailRequests.setMessageRef(requestId, ref.chatId, ref.messageId);
}

// ---------------------------------------------------------------------------
// Tap handling
// ---------------------------------------------------------------------------

/** Typed result of {@link requestMail}. */
export type RequestMailOutcome =
  | { kind: "queued"; request: MailRequest }
  | { kind: "disabled" }
  | { kind: "account_invalid" }
  | { kind: "enqueue_failed" }
  | Exclude<mailRequests.ClaimResult, { kind: "claimed" }>;

/**
 * Add a `send` job for a claimed request. The job id includes the claim count, so a retap
 * after FAILED enqueues anew while a duplicate enqueue of one claim is ignored.
 * @param request - The claimed (QUEUED) request.
 */
async function enqueueSend(request: MailRequest): Promise<void> {
  await mailQueue.add(
    SEND_JOB,
    { requestId: request.id },
    { jobId: `send-${request.id}-${request.attempts}` },
  );
}

/**
 * Handle a tap on the mail button: claim the request atomically in Postgres, then enqueue
 * the send job after the claim has committed.
 * @param requestId - The MailRequest id from the button.
 * @param presserUserId - The user who pressed it (already resolved from the platform user).
 * @param tappedMessage - The message the button sits on; stored on the request before the send
 *   job is enqueued when the request has no message on record, so the result can be reported.
 * @returns `queued` when this tap won the claim, else the reason it was refused.
 */
export async function requestMail(
  requestId: string,
  presserUserId: string,
  tappedMessage?: MessageRef,
): Promise<RequestMailOutcome> {
  if (!config.mail.enabled) return { kind: "disabled" };

  // A known-bad password must not be tried again: repeated failed logins can lock the account.
  const account = await pttAccounts.getPttAccount(presserUserId);
  if (account?.invalidAt) return { kind: "account_invalid" };

  const result = await mailRequests.claim(
    requestId,
    presserUserId,
    config.mail.dailyLimit,
    new Date(),
  );
  if (result.kind !== "claimed") return result;

  if (tappedMessage && (!result.request.chatId || !result.request.messageId)) {
    try {
      await recordNotificationMessage(requestId, tappedMessage);
      result.request = {
        ...result.request,
        chatId: tappedMessage.chatId,
        messageId: tappedMessage.messageId,
      };
    } catch (err) {
      logger.warn(`Could not store the tapped message: ${(err as Error).message}`);
    }
  }

  try {
    await enqueueSend(result.request);
  } catch (err) {
    logger.error(`Failed to enqueue mail ${requestId}: ${(err as Error).message}`);
    await mailRequests.markFailed(requestId, "排隊失敗");
    return { kind: "enqueue_failed" };
  }
  return { kind: "queued", request: result.request };
}

/**
 * Queue a PTT account verification. The caller passes ciphertext only.
 * @param data - User, chat, PTT id and the encrypted password.
 */
export async function enqueueVerifyJob(data: VerifyJobData): Promise<void> {
  await mailQueue.add(VERIFY_JOB, data, { removeOnComplete: true, removeOnFail: true });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Tell the user the outcome. Edits the notification message when the request remembers it and
 * the adapter can; otherwise (or when the edit fails) sends a new message. Never throws.
 * @param target - Chat and, when known, the message to edit.
 * @param text - The result text.
 * @param buttons - Optional buttons for an edited message.
 */
async function report(
  target: { chatId: string | null; messageId?: string | null },
  text: string,
  buttons?: ButtonRows,
): Promise<void> {
  if (!target.chatId) {
    logger.warn("Mail result not reported: no chat id on record");
    return;
  }
  try {
    const adapter = getAdapter("TELEGRAM");
    if (target.messageId && adapter.updateMessage) {
      try {
        await adapter.updateMessage(
          { chatId: target.chatId, messageId: target.messageId },
          text,
          buttons,
        );
        return;
      } catch (err) {
        logger.warn(`Editing the notification failed, sending a reply: ${(err as Error).message}`);
      }
    }
    await adapter.sendReply(target.chatId, text);
  } catch (err) {
    logger.error(`Failed to report mail result: ${(err as Error).message}`);
  }
}

/**
 * Reason text for a failure of the PTT client before the save key.
 * @param code - The client's error code, if any.
 * @returns A short reason.
 */
function reasonFor(code: PttError["code"] | undefined): string {
  switch (code) {
    case "NoSuchUser":
      return FAIL_REASON.noSuchUser;
    case "PttBusy":
      return FAIL_REASON.busy;
    case "Timeout":
      return FAIL_REASON.timeout;
    case "ConnectFailed":
      return FAIL_REASON.connect;
    case "SecureConnectionRequired":
      return FAIL_REASON.secure;
    case "UnfinishedDraft":
      return FAIL_REASON.draft;
    case "TooManySessions":
      return FAIL_REASON.sessions;
    case "LoginThrottled":
      return FAIL_REASON.throttled;
    default:
      return FAIL_REASON.generic;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Load a request and move it QUEUED to SENDING. A database error here means nothing was sent:
 * the row is marked FAILED when the database allows it and the user is told.
 * @param requestId - The MailRequest id.
 * @returns The request when this job may send it, else null (unknown, not QUEUED, or errored).
 */
async function startSend(requestId: string): Promise<MailRequest | null> {
  let request: MailRequest | null = null;
  try {
    request = await mailRequests.getMailRequest(requestId);
    if (!request) {
      logger.warn(`Send job for unknown request ${requestId}`);
      return null;
    }
    if (!(await mailRequests.markSending(requestId))) {
      logger.warn(`Send job skipped: ${requestId} is ${request.status}, not QUEUED`);
      return null;
    }
    return request;
  } catch (err) {
    logger.error(`Send job ${requestId} could not start: ${(err as Error).message}`);
  }

  let marked = false;
  try {
    marked = await mailRequests.markFailed(requestId, FAIL_REASON.generic);
    request ??= await mailRequests.getMailRequest(requestId);
  } catch (err) {
    logger.error(`Send job ${requestId} could not be failed: ${(err as Error).message}`);
  }
  // Tell the user only when the row really moved to FAILED. A row that stayed QUEUED is left
  // for recoverInFlight, and a stale job that finds another status has nothing to report.
  if (!marked || !request) {
    logger.warn(`Send job ${requestId} left as is: the row was not moved to FAILED`);
    return null;
  }
  const canRetry = request.attempts < MAX_MAIL_ATTEMPTS;
  await report(
    request,
    canRetry ? MAIL_TEXT.failedRetry(FAIL_REASON.generic) : MAIL_TEXT.failed(FAIL_REASON.generic),
    canRetry ? [[{ text: "✉️ 再試一次", action: `mail:${requestId}` }]] : undefined,
  );
  return null;
}

/** A job that must wait for the account's login gap; the worker delays it by `deferMs`. */
export interface DeferredJob {
  deferMs: number;
}

/**
 * Ask the login gate before a send job logs in. Only a QUEUED request with a usable account
 * will log in, so every other case returns 0 and lets {@link startSend} decide. A database
 * error defers the job for {@link DB_ERROR_WAIT_MS}: the account is unknown, so going ahead
 * could log in inside its gap once the database answers again. The row stays QUEUED.
 * @param requestId - The MailRequest id.
 * @returns 0 to go ahead now, else the milliseconds to wait.
 */
async function sendLoginWait(requestId: string): Promise<number> {
  let pttId: string;
  try {
    const request = await mailRequests.getMailRequest(requestId);
    if (request?.status !== "QUEUED") return 0;
    const account = await pttAccounts.getPttAccount(request.userId);
    if (!account || account.invalidAt) return 0;
    pttId = account.pttId;
  } catch (err) {
    logger.error(`Send job ${requestId} cannot read its account: ${(err as Error).message}`);
    return DB_ERROR_WAIT_MS;
  }
  return reserveLogin(pttId);
}

/** How long a send job waits when the login gate cannot read its account. */
const DB_ERROR_WAIT_MS = 30_000;

/**
 * Run a `send` job: QUEUED to SENDING, send the mail, then SENT, FAILED or UNKNOWN. The row
 * decides whether to act, so a repeated or stale job does nothing. Never mails twice for one
 * claim: only a certain not-sent outcome returns the row to FAILED. The plaintext password
 * lives only in a local variable and is never logged. When the account logged in less than
 * the login gap ago, nothing changes and the job is returned as deferred (the row stays QUEUED).
 * @param requestId - The MailRequest id.
 * @returns The wait when the job must be delayed, otherwise undefined.
 */
export async function executeSendJob(requestId: string): Promise<DeferredJob | undefined> {
  const wait = await sendLoginWait(requestId);
  if (wait > 0) {
    logger.info(`Send job ${requestId} deferred ${Math.ceil(wait / 1000)}s for the login gap`);
    return { deferMs: wait };
  }
  await runSendJob(requestId);
  return undefined;
}

/**
 * The send job once the login gate let it through.
 * @param requestId - The MailRequest id.
 */
async function runSendJob(requestId: string): Promise<void> {
  const request = await startSend(requestId);
  if (!request) return;

  /** Finish as certainly-not-sent; the button returns while attempts remain. */
  const fail = async (reason: string, opts: { hint?: string; retry?: boolean } = {}) => {
    await mailRequests.markFailed(requestId, reason);
    const canRetry = (opts.retry ?? true) && request.attempts < MAX_MAIL_ATTEMPTS;
    await report(
      request,
      canRetry ? MAIL_TEXT.failedRetry(reason) : MAIL_TEXT.failed(reason, opts.hint),
      canRetry ? [[{ text: "✉️ 再試一次", action: `mail:${requestId}` }]] : undefined,
    );
  };
  /** Finish as unconfirmed; there is no retry. */
  const unknown = async (detail: string) => {
    await mailRequests.markUnknown(requestId, detail);
    await report(request, MAIL_TEXT.unknown(request.author));
  };

  let sendStarted = false;
  try {
    if (!config.mail.enabled) return await fail(FAIL_REASON.disabled, { retry: false });

    const subscription = await findSubscription(request.userId, request.board, request.keyword);
    if (!subscription?.replyContent?.trim()) {
      return await fail(FAIL_REASON.noSubscription, { retry: false });
    }
    const account = await pttAccounts.getPttAccount(request.userId);
    if (!account) return await fail(FAIL_REASON.noAccount, { retry: false });
    if (account.invalidAt) {
      return await fail(FAIL_REASON.accountInvalid, { retry: false, hint: REBIND_HINT });
    }

    let password: string;
    try {
      password = decryptSecret(account.passwordEnc, config.mail.encryptKey);
    } catch {
      logger.error(`Cannot decrypt the stored PTT password for request ${requestId}`);
      return await fail(FAIL_REASON.decrypt, { retry: false, hint: REBIND_HINT });
    }

    const articleText = subscription.replyIncludeOriginal
      ? await loadArticleText(request.articleCode).catch((err) => {
          logger.warn(`Article text unavailable for ${request.articleCode}: ${err.message}`);
          return null;
        })
      : null;
    const mail = buildMail(request, subscription, articleText);

    sendStarted = true;
    const result = await sendPttMail({
      pttId: account.pttId,
      password,
      to: mail.to,
      subject: mail.subject,
      body: mail.body,
    });
    logger.info(
      `Mail ${requestId} outcome=${result.outcome}${result.errorCode ? ` code=${result.errorCode}` : ""}`,
    );

    if (result.outcome === "sent") {
      await mailRequests.markSent(requestId);
      await report(request, MAIL_TEXT.sent(request.author, request.title, mail.originalMissing));
    } else if (result.outcome === "unknown") {
      await unknown(result.errorCode ?? "unknown");
    } else if (result.errorCode === "WrongPassword") {
      await pttAccounts.markPttAccountInvalid(request.userId);
      await fail(FAIL_REASON.accountInvalid, { retry: false, hint: REBIND_HINT });
    } else if (result.errorCode === "TwoFactorRequired") {
      await fail(FAIL_REASON.twoFactor, { retry: false });
    } else {
      if (result.errorCode === "LoginThrottled") await holdLogins(account.pttId);
      await fail(reasonFor(result.errorCode));
    }
  } catch (err) {
    // After the client was called the mail may have left, so only UNKNOWN is safe.
    logger.error(`Send job ${requestId} errored: ${(err as Error).message}`);
    if (sendStarted) await unknown("internal error");
    else await fail(FAIL_REASON.generic);
  }
}

/**
 * Run a `verify` job: log in with the given credentials once; on success save the account
 * (ciphertext as given) and tell the user, else tell the user why not. The queue payload
 * carries only ciphertext; the plaintext exists in a local variable for the login. When the
 * account logged in less than the login gap ago, the job is returned as deferred untouched.
 * @param data - User, chat, PTT id and the encrypted password.
 * @returns The wait when the job must be delayed, otherwise undefined.
 */
export async function executeVerifyJob(data: VerifyJobData): Promise<DeferredJob | undefined> {
  const { userId, chatId, pttId, passwordEnc } = data;
  let text: string;
  try {
    if (!config.mail.enabled) {
      text = MAIL_TEXT.verifyFailed(FAIL_REASON.disabled);
    } else {
      const wait = await reserveLogin(pttId);
      if (wait > 0) {
        logger.info(`Verify job for user ${userId} deferred ${Math.ceil(wait / 1000)}s`);
        return { deferMs: wait };
      }
      const password = decryptSecret(passwordEnc, config.mail.encryptKey);
      await verifyPttLogin(pttId, password);
      await pttAccounts.upsertPttAccount(userId, pttId, passwordEnc);
      text = MAIL_TEXT.verifyOk(pttId);
    }
  } catch (err) {
    if (err instanceof PttError && err.code === "WrongPassword") {
      text = MAIL_TEXT.verifyWrongPassword;
    } else if (err instanceof PttError && err.code === "TwoFactorRequired") {
      text = MAIL_TEXT.verifyTwoFactor;
    } else if (err instanceof PttError && err.code === "UnfinishedDraft") {
      text = MAIL_TEXT.verifyDraft;
    } else if (err instanceof PttError) {
      logger.warn(`Verify failed for user ${userId}: ${err.code}`);
      if (err.code === "LoginThrottled") await holdLogins(pttId);
      text = MAIL_TEXT.verifyFailed(reasonFor(err.code));
    } else {
      logger.error(`Verify job errored for user ${userId}: ${(err as Error).name}`);
      text = MAIL_TEXT.verifyFailed(FAIL_REASON.generic);
    }
  }
  await report({ chatId }, text);
  return undefined;
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

/**
 * Resolve rows a restart left in flight (the boot flush dropped their jobs): QUEUED rows get
 * their send job again; SENDING rows become UNKNOWN, because the mail may already have left,
 * and the user is told.
 * @returns How many rows were re-enqueued and how many turned UNKNOWN.
 */
export async function recoverInFlight(): Promise<{ requeued: number; unknown: number }> {
  const rows = await mailRequests.findInFlight();
  let requeued = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.status === "QUEUED") {
      try {
        await enqueueSend(row);
        requeued++;
      } catch (err) {
        logger.error(`Recovery could not enqueue ${row.id}: ${(err as Error).message}`);
      }
    } else if (await mailRequests.markUnknown(row.id, "restart while sending")) {
      unknown++;
      await report(row, MAIL_TEXT.unknown(row.author));
    }
  }
  if (rows.length > 0) {
    logger.info(`Mail recovery: ${requeued} re-enqueued, ${unknown} marked UNKNOWN`);
  }
  return { requeued, unknown };
}
