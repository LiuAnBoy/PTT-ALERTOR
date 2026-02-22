import type { Context } from "grammy";

import { handleStart, handleText } from "./handlers";

// ---- Mocks ----

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../repositories/channelRepository", () => ({
  findChannelByPlatformUserId: jest.fn(),
  createChannel: jest.fn().mockResolvedValue({}),
}));

jest.mock("../repositories/userRepository", () => ({
  createUser: jest.fn().mockResolvedValue({ id: "new-user-id" }),
}));

jest.mock("../repositories/subscriptionRepository", () => ({
  getSubscriptions: jest.fn().mockResolvedValue([]),
  addSubscription: jest.fn().mockResolvedValue({}),
  deleteSubscription: jest.fn().mockResolvedValue({}),
  subscriptionExists: jest.fn().mockResolvedValue(false),
}));

jest.mock("../services/boardValidator", () => ({
  boardExists: jest.fn().mockResolvedValue(true),
}));

jest.mock("../services/syncService", () => ({
  addSubscriptionToRedis: jest.fn().mockResolvedValue(undefined),
  removeSubscriptionFromRedis: jest.fn().mockResolvedValue(undefined),
}));

// ---- Imports for mocked modules ----

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

const mockedFindChannel = findChannelByPlatformUserId as jest.MockedFunction<
  typeof findChannelByPlatformUserId
>;
const mockedCreateChannel = createChannel as jest.MockedFunction<typeof createChannel>;
const mockedCreateUser = createUser as jest.MockedFunction<typeof createUser>;
const mockedGetSubscriptions = getSubscriptions as jest.MockedFunction<typeof getSubscriptions>;
const mockedAddSubscription = addSubscription as jest.MockedFunction<typeof addSubscription>;
const mockedDeleteSubscription = deleteSubscription as jest.MockedFunction<
  typeof deleteSubscription
>;
const mockedSubscriptionExists = subscriptionExists as jest.MockedFunction<
  typeof subscriptionExists
>;
const mockedBoardExists = boardExists as jest.MockedFunction<typeof boardExists>;
const mockedAddSubToRedis = addSubscriptionToRedis as jest.MockedFunction<
  typeof addSubscriptionToRedis
>;
const mockedRemoveSubFromRedis = removeSubscriptionFromRedis as jest.MockedFunction<
  typeof removeSubscriptionFromRedis
>;

// ---- Helper ----

/**
 * Create a minimal grammy Context stub for testing.
 */
function createCtx(overrides?: {
  from?: { id: number; username?: string } | null;
  chat?: { id: number } | null;
  messageText?: string;
}) {
  return {
    from: overrides?.from !== undefined ? overrides.from : { id: 12345, username: "testuser" },
    chat: overrides?.chat !== undefined ? overrides.chat : { id: 12345 },
    message: overrides?.messageText !== undefined ? { text: overrides.messageText } : undefined,
    reply: jest.fn().mockResolvedValue({}),
  } as unknown as Context;
}

// ---- Tests ----

beforeEach(() => {
  jest.clearAllMocks();

  // Restore safe defaults — individual tests override as needed
  mockedFindChannel.mockResolvedValue(null);
  mockedCreateUser.mockResolvedValue({ id: "new-user-id" } as any);
  mockedCreateChannel.mockResolvedValue({} as any);
  mockedGetSubscriptions.mockResolvedValue([]);
  mockedAddSubscription.mockResolvedValue({} as any);
  mockedDeleteSubscription.mockResolvedValue({} as any);
  mockedSubscriptionExists.mockResolvedValue(false);
  mockedBoardExists.mockResolvedValue(true);
  mockedAddSubToRedis.mockResolvedValue(undefined);
  mockedRemoveSubFromRedis.mockResolvedValue(undefined);
});

// =========================================================================
// handleStart
// =========================================================================

describe("handleStart", () => {
  it("should register a new user when no channel exists", async () => {
    // Arrange — findChannel returns null (new user)
    mockedFindChannel.mockResolvedValueOnce(null);
    const ctx = createCtx();

    // Act
    await handleStart(ctx);

    // Assert
    expect(mockedCreateUser).toHaveBeenCalled();
    expect(mockedCreateChannel).toHaveBeenCalledWith(
      "new-user-id",
      "TELEGRAM",
      "12345",
      "12345",
      "testuser",
    );
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("註冊成功");
  });

  it("should welcome back an existing user", async () => {
    // Arrange — findChannel returns an existing channel
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "existing-id" } } as any);
    const ctx = createCtx();

    // Act
    await handleStart(ctx);

    // Assert
    expect(mockedCreateUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("歡迎回來");
  });

  it("should return early when ctx.from is null", async () => {
    // Arrange
    const ctx = createCtx({ from: null });

    // Act
    await handleStart(ctx);

    // Assert
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(mockedFindChannel).not.toHaveBeenCalled();
  });
});

// =========================================================================
// handleText routing
// =========================================================================

describe("handleText routing", () => {
  it('should reply with usage guide when text is "幫助"', async () => {
    // Arrange
    const ctx = createCtx({ messageText: "幫助" });

    // Act
    await handleText(ctx);

    // Assert
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("使用指南");
  });

  it('should trigger list flow when text is "清單"', async () => {
    // Arrange — registered user with no subscriptions
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedGetSubscriptions.mockResolvedValueOnce([]);
    const ctx = createCtx({ messageText: "清單" });

    // Act
    await handleText(ctx);

    // Assert
    expect(mockedGetSubscriptions).toHaveBeenCalledWith("user-id");
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('should trigger add flow when text starts with "新增"', async () => {
    // Arrange — registered user, board valid, subscription does not exist
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    const ctx = createCtx({ messageText: "新增 Gossiping 問卦" });

    // Act
    await handleText(ctx);

    // Assert
    expect(mockedBoardExists).toHaveBeenCalledWith("Gossiping");
    expect(mockedAddSubscription).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    expect(mockedAddSubToRedis).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("成功新增");
  });

  it('should trigger delete flow when text starts with "刪除"', async () => {
    // Arrange — registered user, subscription exists
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedSubscriptionExists.mockResolvedValueOnce(true);
    const ctx = createCtx({ messageText: "刪除 Gossiping 問卦" });

    // Act
    await handleText(ctx);

    // Assert
    expect(mockedDeleteSubscription).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    expect(mockedRemoveSubFromRedis).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("成功刪除");
  });

  it("should not reply for unrecognized text", async () => {
    // Arrange
    const ctx = createCtx({ messageText: "隨便說說" });

    // Act
    const result = await handleText(ctx);

    // Assert
    expect(result).toBeUndefined();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// =========================================================================
// handleAdd (via handleText)
// =========================================================================

describe("handleAdd (via handleText)", () => {
  it("should reply with format error when keyword is missing", async () => {
    // Arrange — registered user, only board name provided
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    const ctx = createCtx({ messageText: "新增 Gossiping" });

    // Act
    await handleText(ctx);

    // Assert
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("格式錯誤");
  });

  it("should reply with board-not-found when board does not exist", async () => {
    // Arrange
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedBoardExists.mockResolvedValueOnce(false);
    const ctx = createCtx({ messageText: "新增 FakeBoard 關鍵字" });

    // Act
    await handleText(ctx);

    // Assert
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("查無此看板");
  });

  it("should reply with duplicate warning when subscription already exists", async () => {
    // Arrange
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedSubscriptionExists.mockResolvedValueOnce(true);
    const ctx = createCtx({ messageText: "新增 Gossiping 問卦" });

    // Act
    await handleText(ctx);

    // Assert
    expect(mockedAddSubscription).not.toHaveBeenCalled();
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("已訂閱過");
  });

  it("should add all keywords when using & separator", async () => {
    // Arrange — registered user, none of the keywords exist yet
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedSubscriptionExists.mockResolvedValue(false);
    const ctx = createCtx({ messageText: "新增 Gossiping 問卦&爆卦&閒聊" });

    // Act
    await handleText(ctx);

    // Assert — all three keywords should be added
    expect(mockedAddSubscription).toHaveBeenCalledTimes(3);
    expect(mockedAddSubscription).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    expect(mockedAddSubscription).toHaveBeenCalledWith("user-id", "Gossiping", "爆卦");
    expect(mockedAddSubscription).toHaveBeenCalledWith("user-id", "Gossiping", "閒聊");

    expect(mockedAddSubToRedis).toHaveBeenCalledTimes(3);

    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("問卦");
    expect(replyText).toContain("爆卦");
    expect(replyText).toContain("閒聊");
  });
});

// =========================================================================
// handleDelete (via handleText)
// =========================================================================

describe("handleDelete (via handleText)", () => {
  it("should reply with not-subscribed when subscription does not exist", async () => {
    // Arrange
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedSubscriptionExists.mockResolvedValueOnce(false);
    const ctx = createCtx({ messageText: "刪除 Gossiping 問卦" });

    // Act
    await handleText(ctx);

    // Assert
    expect(mockedDeleteSubscription).not.toHaveBeenCalled();
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("尚未訂閱");
  });

  it("should successfully delete an existing subscription", async () => {
    // Arrange
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedSubscriptionExists.mockResolvedValueOnce(true);
    const ctx = createCtx({ messageText: "刪除 Gossiping 問卦" });

    // Act
    await handleText(ctx);

    // Assert
    expect(mockedDeleteSubscription).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    expect(mockedRemoveSubFromRedis).toHaveBeenCalledWith("user-id", "Gossiping", "問卦");
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("成功刪除");
  });
});

// =========================================================================
// handleList (via handleText)
// =========================================================================

describe("handleList (via handleText)", () => {
  it("should reply with no-subscriptions message when list is empty", async () => {
    // Arrange
    mockedFindChannel.mockResolvedValueOnce({ user: { id: "user-id" } } as any);
    mockedGetSubscriptions.mockResolvedValueOnce([]);
    const ctx = createCtx({ messageText: "清單" });

    // Act
    await handleText(ctx);

    // Assert
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as jest.Mock).mock.calls[0][0] as string;
    expect(replyText).toContain("沒有任何訂閱");
  });
});
