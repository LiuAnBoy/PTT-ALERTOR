/**
 * Unit tests for Telegram channel adapter.
 *
 * Covers escapeHtml, formatMessage, and adapter send methods.
 */

import { createMockContext } from "../../../__mocks__/mockContext";
import {
  escapeHtml,
  formatMessage,
  getBot,
  getWebhookHandler,
  handleCallbackQuery,
  handleText,
  startBot,
  telegramAdapter,
} from "../channels/telegram";
import type { NotificationPayload } from "../types";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockBot = {
  api: { sendMessage: jest.fn(), setWebhook: jest.fn(), deleteWebhook: jest.fn() },
};
const mockOn = jest.fn();
let capturedCatch: ((err: unknown) => void) | undefined;
const mockHandleUpdate = jest.fn();
const mockTelegramConfig = {
  token: "test-token",
  webhookUrl: "https://test.com",
  webhookSecret: "s3cret_token-1",
  adminChatId: "",
};
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock("../../../core/config", () => ({
  config: {
    get telegram() {
      return mockTelegramConfig;
    },
  },
}));

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: (...a: any[]) => mockLogger.debug(...a),
    info: (...a: any[]) => mockLogger.info(...a),
    warn: (...a: any[]) => mockLogger.warn(...a),
    error: (...a: any[]) => mockLogger.error(...a),
  }),
}));

// Real webhookCallback and InlineKeyboard, so the secret check and keyboard mapping are tested.
jest.mock("grammy", () => ({
  ...jest.requireActual("grammy"),
  Bot: jest.fn(() => ({
    ...mockBot,
    command: jest.fn(),
    on: (...a: any[]) => mockOn(...a),
    catch: (fn: (err: unknown) => void) => {
      capturedCatch = fn;
    },
    isRunning: () => false,
    init: async () => undefined,
    handleUpdate: (...a: any[]) => mockHandleUpdate(...a),
  })),
}));

jest.mock("../registry", () => ({
  registerAdapter: jest.fn(),
}));

jest.mock("../../user/services/errorLogger", () => ({
  clearErrors: jest.fn(),
  getRecentErrors: jest.fn(),
}));

const mockExecuteSubAction = jest.fn();
const mockExecuteBindStart = jest.fn();
const mockHandlePending = jest.fn();
const mockParseCommand = jest.fn();

jest.mock("../commandHandler", () => ({
  executeStart: jest.fn(),
  executeHelp: jest.fn(),
  executeList: jest.fn(),
  executeAdd: jest.fn(),
  executeDelete: jest.fn(),
  executeBoardStats: jest.fn(),
  executeUnbind: jest.fn(),
  executeBindStart: (...a: any[]) => mockExecuteBindStart(...a),
  executeSubAction: (...a: any[]) => mockExecuteSubAction(...a),
  handlePending: (...a: any[]) => mockHandlePending(...a),
  parseCommand: (...a: any[]) => mockParseCommand(...a),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    userId: "user-1",
    keyword: "keyword",
    articleCode: "M.123456.A.B00",
    board: "Gossiping",
    title: "Test Article Title",
    author: "testauthor",
    pushSum: 42,
    link: "https://www.ptt.cc/bbs/Gossiping/M.123456.A.B00.html",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it('should escape "&" to "&amp;"', () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it('should escape "<" to "&lt;"', () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it('should escape ">" to "&gt;"', () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it('should escape double quotes to "&quot;"', () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("should escape single quotes to '&#39;'", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });
});

describe("formatMessage", () => {
  it("should contain keyword, board, author, title, and link", () => {
    const payload = buildPayload();
    const message = formatMessage(payload);

    expect(message).toContain(payload.keyword);
    expect(message).toContain(payload.board);
    expect(message).toContain(payload.title);
    expect(message).toContain(payload.author as string);
    expect(message).toContain(payload.link);
  });

  it("should place author before title", () => {
    const payload = buildPayload();
    const message = formatMessage(payload);
    expect(message.indexOf(payload.author as string)).toBeLessThan(message.indexOf(payload.title));
  });

  it('should show "unknown" when author is null', () => {
    const message = formatMessage(buildPayload({ author: null }));
    expect(message).toContain("unknown");
  });

  it("should escape HTML characters in title", () => {
    const message = formatMessage(buildPayload({ title: "<script>alert('xss')</script>" }));
    expect(message).not.toContain("<script>");
    expect(message).toContain("&lt;script&gt;");
  });

  it("should truncate messages longer than 4096 characters", () => {
    const message = formatMessage(buildPayload({ title: "A".repeat(5000) }));
    expect(message.length).toBe(4096);
    expect(message).toMatch(/\.\.\.$/);
  });
});

describe("telegramAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should have platform set to TELEGRAM", () => {
    expect(telegramAdapter.platform).toBe("TELEGRAM");
  });

  it("should have rate limit 30 msg/s", () => {
    expect(telegramAdapter.rateLimit).toEqual({ max: 30, duration: 1_000 });
  });

  it("sendReply should send plain text", async () => {
    mockBot.api.sendMessage.mockResolvedValue(undefined);
    await telegramAdapter.sendReply("chat-1", "Hello");
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith("chat-1", "Hello");
  });

  it("sendNotification should send HTML with link preview disabled", async () => {
    const payload = buildPayload();
    mockBot.api.sendMessage.mockResolvedValue(undefined);
    await telegramAdapter.sendNotification("chat-1", payload);
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith("chat-1", formatMessage(payload), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("sendAlert should send plain text", async () => {
    mockBot.api.sendMessage.mockResolvedValue(undefined);
    await telegramAdapter.sendAlert("admin-chat", "Error occurred");
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith("admin-chat", "Error occurred");
  });
});

// ─── Webhook secret ─────────────────────────────────────────────────────────

describe("webhook secret", () => {
  function fakeRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    return res;
  }
  const fakeReq = (header?: string) => ({
    body: { update_id: 1 },
    header: (name: string) => (name === "X-Telegram-Bot-Api-Secret-Token" ? header : undefined),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockTelegramConfig.webhookSecret = "s3cret_token-1";
    mockHandleUpdate.mockResolvedValue(undefined);
  });

  it("rejects a request without the secret and never processes the update", async () => {
    const res = fakeRes();
    await getWebhookHandler()(fakeReq() as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockHandleUpdate).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret", async () => {
    const res = fakeRes();
    await getWebhookHandler()(fakeReq("wrong") as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockHandleUpdate).not.toHaveBeenCalled();
  });

  it("processes a request carrying the secret", async () => {
    await getWebhookHandler()(fakeReq("s3cret_token-1") as any, fakeRes());
    expect(mockHandleUpdate).toHaveBeenCalledTimes(1);
  });

  it("accepts any request when no secret is configured", async () => {
    mockTelegramConfig.webhookSecret = "";
    await getWebhookHandler()(fakeReq() as any, fakeRes());
    expect(mockHandleUpdate).toHaveBeenCalledTimes(1);
  });

  it("registers the webhook with the secret_token, or undefined when unset", async () => {
    mockBot.api.setWebhook.mockResolvedValue(true);
    await startBot();
    expect(mockBot.api.setWebhook).toHaveBeenLastCalledWith(
      "https://test.com/api/telegram/webhook",
      { secret_token: "s3cret_token-1" },
    );
    mockTelegramConfig.webhookSecret = "";
    await startBot();
    expect(mockBot.api.setWebhook).toHaveBeenLastCalledWith(
      "https://test.com/api/telegram/webhook",
      { secret_token: undefined },
    );
  });
});

// ─── Text routing and callbacks ─────────────────────────────────────────────

describe("handleText and callbacks", () => {
  const PASSWORD = "S3cretPw";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sends the pending-input reply with an inline keyboard and skips command parsing", async () => {
    mockHandlePending.mockResolvedValue({
      reply: "card",
      buttons: [[{ text: "✏️ 設定回信內容", action: "sub:s1:reply" }]],
    });
    const ctx = createMockContext({ messageText: "hello" });
    await handleText(ctx as any);

    expect(mockParseCommand).not.toHaveBeenCalled();
    const [text, other] = ctx.reply.mock.calls[0];
    expect(text).toBe("card");
    expect(other.reply_markup.inline_keyboard).toEqual([
      [{ text: "✏️ 設定回信內容", callback_data: "sub:s1:reply" }],
    ]);
  });

  it("passes isPrivate=false for a group and deletes through ctx.deleteMessage", async () => {
    mockHandlePending.mockResolvedValue(null);
    mockParseCommand.mockReturnValue({ command: "bindPtt", args: "" });
    mockExecuteBindStart.mockResolvedValue({ reply: "refused" });
    const ctx = createMockContext({
      messageText: "綁定PTT",
      chat: { id: -100, type: "supergroup" },
    });
    await handleText(ctx as any);

    const cmdCtx = mockExecuteBindStart.mock.calls[0][0];
    expect(cmdCtx.isPrivate).toBe(false);
    await cmdCtx.deleteInputMessage();
    expect(ctx.deleteMessage).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith("refused");
  });

  it("routes sub: presses as the presser, edits the card and answers the query", async () => {
    mockExecuteSubAction.mockResolvedValue({
      reply: "updated card",
      edit: true,
      buttons: [[{ text: "🗑 清除回信", action: "sub:s1:clear" }]],
    });
    const ctx = createMockContext({ callbackData: "sub:s1:orig" });
    await handleCallbackQuery(ctx as any);

    expect(mockExecuteSubAction).toHaveBeenCalledWith(
      expect.objectContaining({ platformUserId: "12345" }),
      "s1",
      "orig",
    );
    expect(ctx.editMessageText).toHaveBeenCalledWith("updated card", {
      reply_markup: expect.anything(),
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("sends a new message for open, and shows the refusal toast for a foreign subscription", async () => {
    mockExecuteSubAction.mockResolvedValue({
      reply: "❌ 找不到這個訂閱。",
      toast: "找不到這個訂閱",
    });
    const ctx = createMockContext({ callbackData: "sub:other:open" });
    await handleCallbackQuery(ctx as any);

    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("❌ 找不到這個訂閱。");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "找不到這個訂閱" });
  });

  it("answers the query even when the action throws, and logs no more than the error name", async () => {
    mockExecuteSubAction.mockRejectedValue(new Error(`boom ${PASSWORD}`));
    const ctx = createMockContext({ callbackData: "sub:s1:reply" });
    await handleCallbackQuery(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(PASSWORD);
  });

  it("answers an unknown prefix without running anything", async () => {
    const ctx = createMockContext({ callbackData: "other:1" });
    await handleCallbackQuery(ctx as any);
    expect(mockExecuteSubAction).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("bot.catch logs the update id and error name, never the message text", () => {
    getBot();
    const handler = capturedCatch;
    expect(handler).toBeDefined();
    handler!({
      message: `Error in middleware ${PASSWORD}`,
      error: new TypeError(`bad ${PASSWORD}`),
      ctx: { update: { update_id: 42, message: { text: PASSWORD } } },
    });
    const logged = JSON.stringify(mockLogger.error.mock.calls);
    expect(logged).toContain("42");
    expect(logged).not.toContain(PASSWORD);
  });

  it("the password text never reaches the logger on the text path", async () => {
    mockHandlePending.mockResolvedValue({ reply: "⏳ 驗證中…" });
    const ctx = createMockContext({ messageText: PASSWORD });
    await handleText(ctx as any);
    const logged = JSON.stringify(
      [mockLogger.debug, mockLogger.info, mockLogger.warn, mockLogger.error].map(
        (f) => f.mock.calls,
      ),
    );
    expect(logged).not.toContain(PASSWORD);
  });
});
