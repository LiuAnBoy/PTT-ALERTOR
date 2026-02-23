/**
 * Unit tests for notifierService.
 *
 * Covers sendNotification with platform adapter dispatch,
 * error classification (permanent vs temporary), and retry behavior.
 */

import type { NotificationPayload } from "../../broadcast/types";
import { logError } from "../../user/services/errorLogger";
import { isPermanentError, sendNotification } from "../services/notifierService";

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

describe("isPermanentError", () => {
  it("should return true for bot blocked error", () => {
    expect(isPermanentError(new Error("bot was blocked by the user"))).toBe(true);
  });

  it("should return true for deactivated user", () => {
    expect(isPermanentError(new Error("user is deactivated"))).toBe(true);
  });

  it("should return true for 403 status", () => {
    const err = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    expect(isPermanentError(err)).toBe(true);
  });

  it("should return false for network error", () => {
    expect(isPermanentError(new Error("ECONNRESET"))).toBe(false);
  });

  it("should return false for 429 rate limit", () => {
    const err = Object.assign(new Error("Too Many Requests"), { response: { status: 429 } });
    expect(isPermanentError(err)).toBe(false);
  });
});

describe("sendNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should send notification via adapter and return true", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" }],
    });
    mockAdapter.sendNotification.mockResolvedValue(undefined);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(true);
    expect(mockAdapter.sendNotification).toHaveBeenCalledWith("chat-1", buildPayload());
  });

  it("should return false when user is not found", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(mockAdapter.sendNotification).not.toHaveBeenCalled();
  });

  it("should return false when user.enable is false", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: false,
      channels: [{ id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" }],
    });

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
  });

  it("should return false when user has no channels", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [],
    });

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
  });

  it("should return true when one channel fails but another succeeds", async () => {
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
  });

  it("should throw temporary error when all channels fail with temporary errors", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" }],
    });
    mockAdapter.sendNotification.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(sendNotification(buildPayload())).rejects.toThrow("ECONNRESET");
  });

  it("should return false without throwing when all channels fail with permanent errors", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [{ id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" }],
    });
    mockAdapter.sendNotification.mockRejectedValueOnce(new Error("bot was blocked by the user"));

    const result = await sendNotification(buildPayload());

    expect(result).toBe(false);
    expect(logError).toHaveBeenCalledWith(
      "ERROR",
      "NOTIFIER",
      "TELEGRAM send failed (permanent)",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("should log permanent and temporary errors with different labels", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      enable: true,
      channels: [
        { id: "ch-1", platform: "TELEGRAM", platformChatId: "chat-1" },
        { id: "ch-2", platform: "TELEGRAM", platformChatId: "chat-2" },
      ],
    });
    mockAdapter.sendNotification
      .mockRejectedValueOnce(new Error("bot was blocked by the user"))
      .mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(sendNotification(buildPayload())).rejects.toThrow("ECONNRESET");

    expect(logError).toHaveBeenCalledWith(
      "ERROR",
      "NOTIFIER",
      "TELEGRAM send failed (permanent)",
      expect.objectContaining({ channelId: "ch-1" }),
    );
    expect(logError).toHaveBeenCalledWith(
      "ERROR",
      "NOTIFIER",
      "TELEGRAM send failed (temporary)",
      expect.objectContaining({ channelId: "ch-2" }),
    );
  });

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
