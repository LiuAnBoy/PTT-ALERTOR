/**
 * Unit tests for commandHandler.
 *
 * Covers parseCommand, executeStart, executeList, executeAdd, executeDelete.
 */

import {
  executeAdd,
  executeBoardStats,
  executeDelete,
  executeList,
  executeStart,
  parseCommand,
} from "../commandHandler";
import type { CommandContext } from "../types";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateUser = jest.fn();
const mockCreateChannel = jest.fn();
const mockFindChannel = jest.fn();
const mockGetSubscriptions = jest.fn();
const mockSubscriptionExists = jest.fn();
const mockAddSubscription = jest.fn();
const mockDeleteSubscription = jest.fn();
const mockResolveBoard = jest.fn();
const mockAddToRedis = jest.fn();
const mockRemoveFromRedis = jest.fn();
const mockCountByBoard = jest.fn();

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../../user/repositories/userRepository", () => ({
  createUser: (...args: any[]) => mockCreateUser(...args),
}));

jest.mock("../../user/repositories/channelRepository", () => ({
  createChannel: (...args: any[]) => mockCreateChannel(...args),
  findChannelByPlatformUserId: (...args: any[]) => mockFindChannel(...args),
}));

jest.mock("../../user/repositories/subscriptionRepository", () => ({
  getSubscriptions: (...args: any[]) => mockGetSubscriptions(...args),
  subscriptionExists: (...args: any[]) => mockSubscriptionExists(...args),
  addSubscription: (...args: any[]) => mockAddSubscription(...args),
  deleteSubscription: (...args: any[]) => mockDeleteSubscription(...args),
  countByBoard: (...args: any[]) => mockCountByBoard(...args),
}));

jest.mock("../../user/services/boardValidator", () => ({
  resolveBoard: (...args: any[]) => mockResolveBoard(...args),
}));

jest.mock("../../user/services/syncService", () => ({
  addSubscriptionToRedis: (...args: any[]) => mockAddToRedis(...args),
  removeSubscriptionFromRedis: (...args: any[]) => mockRemoveFromRedis(...args),
}));

const mockIsPatternSafe = jest.fn().mockReturnValue(true);

jest.mock("../../subscription/services/regexCache", () => ({
  isPatternSafe: (...args: any[]) => mockIsPatternSafe(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    platform: "TELEGRAM",
    platformUserId: "123",
    platformChatId: "123",
    displayName: "Test User",
    rawData: { id: 123, first_name: "Test", last_name: "User", username: "testuser" },
    text: "",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("parseCommand", () => {
  it("should parse 幫助", () => {
    expect(parseCommand("幫助")).toEqual({ command: "help", args: "" });
  });

  it("should parse 清單", () => {
    expect(parseCommand("清單")).toEqual({ command: "list", args: "" });
  });

  it("should parse 新增 with args", () => {
    expect(parseCommand("新增 Gossiping 問卦")).toEqual({ command: "add", args: "Gossiping 問卦" });
  });

  it("should parse 刪除 with args", () => {
    expect(parseCommand("刪除 Gossiping 問卦")).toEqual({
      command: "delete",
      args: "Gossiping 問卦",
    });
  });

  it("should parse 熱門 with args", () => {
    expect(parseCommand("熱門 Gamesale")).toEqual({
      command: "boardStats",
      args: "Gamesale",
    });
  });

  it("should return null for unrecognized text", () => {
    expect(parseCommand("hello")).toBeNull();
  });
});

describe("executeStart", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should create user with displayName and channel with rawData for new user", async () => {
    mockFindChannel.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({ id: "user-1" });
    mockCreateChannel.mockResolvedValue({});

    const ctx = buildCtx();
    const result = await executeStart(ctx);

    expect(result.reply).toContain("註冊成功");
    expect(mockCreateUser).toHaveBeenCalledWith("Test User");
    expect(mockCreateChannel).toHaveBeenCalledWith("user-1", "TELEGRAM", "123", "123", ctx.rawData);
  });

  it("should welcome back existing user", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });

    const result = await executeStart(buildCtx());

    expect(result.reply).toContain("歡迎回來");
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("should use platformUserId in log when displayName is undefined", async () => {
    mockFindChannel.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({ id: "user-1" });
    mockCreateChannel.mockResolvedValue({});

    const result = await executeStart(buildCtx({ displayName: undefined }));

    expect(result.reply).toContain("註冊成功");
    expect(mockCreateUser).toHaveBeenCalledWith(undefined);
  });

  it("should return error message on failure", async () => {
    mockFindChannel.mockRejectedValue(new Error("DB error"));

    const result = await executeStart(buildCtx());

    expect(result.reply).toContain("伺服器錯誤");
  });
});

describe("executeList", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should return prompt when user not found", async () => {
    mockFindChannel.mockResolvedValue(null);

    const result = await executeList(buildCtx());

    expect(result.reply).toContain("/start");
  });

  it("should return empty message when no subscriptions", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockGetSubscriptions.mockResolvedValue([]);

    const result = await executeList(buildCtx());

    expect(result.reply).toContain("沒有任何訂閱");
  });

  it("should group subscriptions by board", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockGetSubscriptions.mockResolvedValue([
      { board: "Gossiping", keyword: "問卦" },
      { board: "Gossiping", keyword: "爆卦" },
      { board: "Stock", keyword: "台積電" },
    ]);

    const result = await executeList(buildCtx());

    expect(result.reply).toContain("Gossiping");
    expect(result.reply).toContain("Stock");
    expect(result.reply).toContain("問卦");
  });
});

describe("executeAdd", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should return error when args are insufficient", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });

    const result = await executeAdd(buildCtx(), "Gossiping");

    expect(result.reply).toContain("格式錯誤");
  });

  it("should return error when board does not exist", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue(null);

    const result = await executeAdd(buildCtx(), "FakeBoard keyword");

    expect(result.reply).toContain("查無此看板");
  });

  it("should resolve canonical board name from PTT", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Stock");
    mockSubscriptionExists.mockResolvedValue(false);
    mockAddSubscription.mockResolvedValue({});
    mockAddToRedis.mockResolvedValue(undefined);

    const result = await executeAdd(buildCtx(), "stock 台積電");

    expect(result.reply).toContain("成功新增");
    expect(mockResolveBoard).toHaveBeenCalledWith("stock");
    expect(mockAddSubscription).toHaveBeenCalledWith("user-1", "Stock", "台積電");
  });

  it("should add subscription successfully", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockSubscriptionExists.mockResolvedValue(false);
    mockAddSubscription.mockResolvedValue({});
    mockAddToRedis.mockResolvedValue(undefined);

    const result = await executeAdd(buildCtx(), "Gossiping 問卦");

    expect(result.reply).toContain("成功新增");
    expect(mockAddSubscription).toHaveBeenCalledWith("user-1", "Gossiping", "問卦");
  });

  it("should handle duplicate subscription", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockSubscriptionExists.mockResolvedValue(true);

    const result = await executeAdd(buildCtx(), "Gossiping 問卦");

    expect(result.reply).toContain("已訂閱過");
  });

  it("should save regex pattern directly without prefix", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockSubscriptionExists.mockResolvedValue(false);
    mockAddSubscription.mockResolvedValue({});
    mockAddToRedis.mockResolvedValue(undefined);

    const result = await executeAdd(buildCtx(), "Gossiping 問卦|爆卦");

    expect(result.reply).toContain("成功新增");
    expect(mockAddSubscription).toHaveBeenCalledWith("user-1", "Gossiping", "問卦|爆卦");
  });

  it("should save invalid regex (like C++) without error", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockSubscriptionExists.mockResolvedValue(false);
    mockAddSubscription.mockResolvedValue({});
    mockAddToRedis.mockResolvedValue(undefined);

    const result = await executeAdd(buildCtx(), "Gossiping C++");

    expect(result.reply).toContain("成功新增");
    expect(mockAddSubscription).toHaveBeenCalledWith("user-1", "Gossiping", "C++");
  });

  it("should reject unsafe regex pattern", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockIsPatternSafe.mockReturnValueOnce(false);

    const result = await executeAdd(buildCtx(), "Gossiping (a+)+$");

    expect(result.reply).toContain("正則過於複雜或過長");
    expect(mockAddSubscription).not.toHaveBeenCalled();
  });

  it("should store AND keyword (a&b) as a single subscription", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gamesale");
    mockSubscriptionExists.mockResolvedValue(false);
    mockAddSubscription.mockResolvedValue({});
    mockAddToRedis.mockResolvedValue(undefined);

    const result = await executeAdd(buildCtx(), "gamesale 售&ps5");

    expect(result.reply).toBe("✅ 成功新增：[Gamesale] — 售&ps5");
    expect(mockAddSubscription).toHaveBeenCalledTimes(1);
    expect(mockAddSubscription).toHaveBeenCalledWith("user-1", "Gamesale", "售&ps5");
    expect(mockAddToRedis).toHaveBeenCalledWith("user-1", "Gamesale", "售&ps5");
  });

  it("should reject AND keyword if any sub-pattern is unsafe regex", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    // First part is safe, second part is unsafe
    mockIsPatternSafe.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await executeAdd(buildCtx(), "Gossiping good&(a+)+$");

    expect(result.reply).toContain("正則過於複雜或過長");
    expect(mockAddSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ["lone &", "Gossiping &"],
    ["doubled & in middle", "Gossiping 售&&ps5"],
    ["trailing &", "Gossiping 售&"],
    ["leading &", "Gossiping &ps5"],
  ])("should reject malformed AND keyword (%s)", async (_label, args) => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");

    const result = await executeAdd(buildCtx(), args);

    expect(result.reply).toMatch(/格式錯誤|不可為空/);
    expect(mockAddSubscription).not.toHaveBeenCalled();
  });
});

describe("executeBoardStats", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should return error when board name is empty", async () => {
    const result = await executeBoardStats("");
    expect(result.reply).toContain("格式錯誤");
    expect(mockCountByBoard).not.toHaveBeenCalled();
  });

  it("should return error when board does not exist", async () => {
    mockResolveBoard.mockResolvedValue(null);

    const result = await executeBoardStats("FakeBoard");

    expect(result.reply).toContain("查無此看板");
    expect(mockCountByBoard).not.toHaveBeenCalled();
  });

  it("should return empty message when no subscriptions", async () => {
    mockResolveBoard.mockResolvedValue("Gamesale");
    mockCountByBoard.mockResolvedValue([]);

    const result = await executeBoardStats("gamesale");

    expect(result.reply).toContain("Gamesale");
    expect(result.reply).toContain("目前無人訂閱");
  });

  it("should list keywords ordered with subscriber counts", async () => {
    mockResolveBoard.mockResolvedValue("Gamesale");
    mockCountByBoard.mockResolvedValue([
      { keyword: "ps5", subs: 15 },
      { keyword: "switch", subs: 12 },
      { keyword: "售&ps5", subs: 8 },
    ]);

    const result = await executeBoardStats("gamesale");

    expect(mockCountByBoard).toHaveBeenCalledWith("Gamesale", 50);
    expect(result.reply).toContain("Gamesale 熱門關鍵字");
    expect(result.reply).toContain("ps5");
    expect(result.reply).toContain("switch");
    expect(result.reply).toContain("售&ps5");
    // Counts should appear in the output
    expect(result.reply).toContain("15");
    expect(result.reply).toContain("8");
  });
});

describe("executeDelete", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should delete subscription successfully", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockSubscriptionExists.mockResolvedValue(true);
    mockDeleteSubscription.mockResolvedValue({});
    mockRemoveFromRedis.mockResolvedValue(undefined);

    const result = await executeDelete(buildCtx(), "Gossiping 問卦");

    expect(result.reply).toContain("成功刪除");
  });

  it("should return error when subscription does not exist", async () => {
    mockFindChannel.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveBoard.mockResolvedValue("Gossiping");
    mockSubscriptionExists.mockResolvedValue(false);

    const result = await executeDelete(buildCtx(), "Gossiping 問卦");

    expect(result.reply).toContain("尚未訂閱");
  });
});
