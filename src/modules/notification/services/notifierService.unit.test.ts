/**
 * Unit tests for notifierService.
 *
 * Covers sendNotification with platform adapter dispatch.
 */

import type { NotificationPayload } from "../../broadcast/types";
import { logError } from "../../user/services/errorLogger";
import { sendNotification } from "./notifierService";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockPrisma = { user: { findUnique: jest.fn() } };

const mockAdapter = {
  platform: "TELEGRAM" as const,
  sendReply: jest.fn(),
  sendNotification: jest.fn(),
  sendAlert: jest.fn(),
  rateLimit: { max: 30, duration: 1_000 },
};

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

jest.mock("../../broadcast/registry", () => ({
  getAdapter: () => mockAdapter,
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

describe("sendNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Case 1
  it("should send notification via adapter and return true", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" }],
    });
    mockAdapter.sendNotification.mockResolvedValue(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockAdapter.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockAdapter.sendNotification).toHaveBeenCalledWith("chat-1", buildPayload());
  });

  // Case 2
  it("should return false when user is not found", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(mockAdapter.sendNotification).not.toHaveBeenCalled();
  });

  // Case 3
  it("should return false when user is found but enable is false", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: false,
      channels: [{ id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" }],
    });

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(mockAdapter.sendNotification).not.toHaveBeenCalled();
  });

  // Case 4
  it("should return false when user has no channels", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [],
    });

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
  });

  // Case 5
  it("should return true when one channel fails but another succeeds (partial success)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" },
        { id: "ch-2", platform: "TELEGRAM", platformChatId: "chat-2" },
      ],
    });
    mockAdapter.sendNotification
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockAdapter.sendNotification).toHaveBeenCalledTimes(2);
  });

  // Case 6
  it("should return false and call logError when all channels fail", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" },
        { id: "ch-2", platform: "TELEGRAM", platformChatId: "chat-2" },
      ],
    });
    mockAdapter.sendNotification
      .mockRejectedValueOnce(new Error("Fail 1"))
      .mockRejectedValueOnce(new Error("Fail 2"));

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  // Case 7
  it("should call logError with platform name on channel failure", async () => {
    const payload = buildPayload({ userId: "user-err" });
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-fail", platform: "TELEGRAM", platformChatId: "chat-fail" }],
    });
    mockAdapter.sendNotification.mockRejectedValueOnce(new Error("Bot blocked by user"));

    await sendNotification(payload);

    expect(logError).toHaveBeenCalledWith("ERROR", "NOTIFIER", "TELEGRAM send failed", {
      userId: "user-err",
      channelId: "ch-fail",
      error: "Bot blocked by user",
    });
  });

  // Case 8
  it("should send to multiple channels all successfully", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" },
        { id: "ch-2", platform: "TELEGRAM", platformChatId: "chat-2" },
        { id: "ch-3", platform: "TELEGRAM", platformChatId: "chat-3" },
      ],
    });
    mockAdapter.sendNotification.mockResolvedValue(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockAdapter.sendNotification).toHaveBeenCalledTimes(3);
  });

  // Case 9
  it("should query all channels without platform filter", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [],
    });

    await sendNotification(buildPayload());

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { enable: true, channels: true },
    });
  });
});
