/**
 * Unit tests for Telegram channel adapter.
 *
 * Covers escapeHtml, formatMessage, and adapter send methods.
 */

import type { NotificationPayload } from "../types";
import { escapeHtml, formatMessage, telegramAdapter } from "./telegram";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockBot = { api: { sendMessage: jest.fn() } };

jest.mock("../../../core/config", () => ({
  config: { telegram: { token: "test-token", webhookUrl: "https://test.com" } },
}));

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("grammy", () => ({
  Bot: jest.fn(() => ({
    ...mockBot,
    command: jest.fn(),
    on: jest.fn(),
    catch: jest.fn(),
  })),
  webhookCallback: jest.fn(),
}));

jest.mock("../registry", () => ({
  registerAdapter: jest.fn(),
}));

jest.mock("../../user/services/errorLogger", () => ({
  clearErrors: jest.fn(),
  getRecentErrors: jest.fn(),
}));

jest.mock("../commandHandler", () => ({
  executeStart: jest.fn(),
  executeHelp: jest.fn(),
  executeList: jest.fn(),
  executeAdd: jest.fn(),
  executeDelete: jest.fn(),
  parseCommand: jest.fn(),
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
