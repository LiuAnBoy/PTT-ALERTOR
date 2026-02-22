/**
 * Unit tests for notifierService.
 *
 * Covers escapeHtml, formatMessage, and sendNotification.
 */

import { logError } from "../../user/services/errorLogger";
import type { NotificationPayload } from "./notifierService";
import { escapeHtml, formatMessage, sendNotification } from "./notifierService";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockPrisma = { user: { findUnique: jest.fn() } };
const mockBot = { api: { sendMessage: jest.fn() } };

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../../../core/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

jest.mock("../../user/bot/bot", () => ({
  getBot: () => mockBot,
}));

jest.mock("../../user/services/errorLogger", () => ({
  logError: jest.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a standard payload for reuse across tests. */
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
  // Case 1
  it('should escape "&" to "&amp;"', () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  // Case 2
  it('should escape "<" to "&lt;"', () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  // Case 3
  it('should escape ">" to "&gt;"', () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });
});

describe("formatMessage", () => {
  // Case 4
  it("should produce a standard format containing keyword, board, author, title, and link", () => {
    const payload = buildPayload();
    const message = formatMessage(payload);

    expect(message).toContain(payload.keyword);
    expect(message).toContain(payload.board);
    expect(message).toContain(payload.title);
    expect(message).toContain(payload.author as string);
    expect(message).toContain(payload.link);
    expect(message).not.toContain("pushSum");
  });

  // Case 4b
  it("should place author before title in the message", () => {
    const payload = buildPayload();
    const message = formatMessage(payload);

    const authorIndex = message.indexOf(payload.author as string);
    const titleIndex = message.indexOf(payload.title);
    expect(authorIndex).toBeLessThan(titleIndex);
  });

  // Case 5
  it('should show "unknown" when author is null', () => {
    const payload = buildPayload({ author: null });
    const message = formatMessage(payload);

    expect(message).toContain("unknown");
  });

  // Case 6
  it("should escape HTML characters in title", () => {
    const payload = buildPayload({ title: "<script>alert('xss')</script>" });
    const message = formatMessage(payload);

    expect(message).not.toContain("<script>");
    expect(message).toContain("&lt;script&gt;");
  });

  // Case 7
  it("should truncate messages longer than 4096 characters with '...'", () => {
    const longTitle = "A".repeat(5000);
    const payload = buildPayload({ title: longTitle });
    const message = formatMessage(payload);

    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toMatch(/\.\.\.$/);
  });

  // Case 8
  it("should have exactly 4096 characters after truncation", () => {
    const longTitle = "A".repeat(5000);
    const payload = buildPayload({ title: longTitle });
    const message = formatMessage(payload);

    expect(message.length).toBe(4096);
  });
});

describe("sendNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Case 9
  it("should send notification and return true when user is found, enabled, and has channels", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-1", platformChatId: "chat-1" }],
    });
    mockBot.api.sendMessage.mockResolvedValue(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  // Case 10
  it("should return false when user is not found", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  // Case 11
  it("should return false when user is found but enable is false", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: false,
      channels: [{ id: "ch-1", platformChatId: "chat-1" }],
    });

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  // Case 12
  it("should return false when user is found but has no channels", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [],
    });

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  // Case 13
  it("should return true when multiple channels exist and only one fails (partial success)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platformChatId: "chat-1" },
        { id: "ch-2", platformChatId: "chat-2" },
      ],
    });
    mockBot.api.sendMessage
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  // Case 14
  it("should return false and call logError when all channels fail", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platformChatId: "chat-1" },
        { id: "ch-2", platformChatId: "chat-2" },
      ],
    });
    mockBot.api.sendMessage
      .mockRejectedValueOnce(new Error("Fail 1"))
      .mockRejectedValueOnce(new Error("Fail 2"));

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  // Case 15
  it("should send the message with correct HTML parse mode and link preview disabled", async () => {
    const payload = buildPayload();
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-1", platformChatId: "chat-1" }],
    });
    mockBot.api.sendMessage.mockResolvedValue(undefined);

    await sendNotification(payload);

    const expectedMessage = formatMessage(payload);
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith("chat-1", expectedMessage, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  // Case 16
  it("should return true when multiple channels all succeed", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platformChatId: "chat-1" },
        { id: "ch-2", platformChatId: "chat-2" },
        { id: "ch-3", platformChatId: "chat-3" },
      ],
    });
    mockBot.api.sendMessage.mockResolvedValue(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(3);
  });

  // Case 17
  it("should call logError with correct params on channel failure", async () => {
    const payload = buildPayload({ userId: "user-err" });
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-fail", platformChatId: "chat-fail" }],
    });
    mockBot.api.sendMessage.mockRejectedValueOnce(new Error("Bot blocked by user"));

    await sendNotification(payload);

    expect(logError).toHaveBeenCalledWith("ERROR", "NOTIFIER", "Telegram send failed", {
      userId: "user-err",
      channelId: "ch-fail",
      telegramError: "Bot blocked by user",
    });
  });
});
