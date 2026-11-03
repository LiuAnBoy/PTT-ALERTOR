/**
 * Unit tests for commandHandler.
 *
 * Covers parseCommand, executeStart, executeList, executeAdd, executeDelete.
 */

import { decryptSecret } from "../../../core/crypto";
import {
  executeAdd,
  executeBindStart,
  executeBoardStats,
  executeDelete,
  executeList,
  executeStart,
  executeSubAction,
  executeUnbind,
  handlePending,
  parseCommand,
  PASSWORD_DELETE_WARNING,
  PTT_DISCLAIMER,
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
const mockGetSubscriptionById = jest.fn();
const mockSetReplyContent = jest.fn();
const mockSetReplyIncludeOriginal = jest.fn();
const mockDeletePttAccount = jest.fn();
const mockEnqueueVerifyJob = jest.fn();
const mockTerminal = jest.fn();
const mockConfig = {
  mail: { enabled: true, encryptKey: Buffer.alloc(32, 7).toString("base64"), dailyLimit: 20 },
};
/** In-memory stand-in for the Redis string commands the pending state uses. */
const redisStore = new Map<string, string>();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock("../../../core/config", () => ({
  config: {
    get mail() {
      return mockConfig.mail;
    },
  },
}));

jest.mock("../../../core/redis", () => ({
  redis: {
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      redisStore.set(k, v);
      return "OK";
    },
    del: async (k: string) => (redisStore.delete(k) ? 1 : 0),
  },
}));

jest.mock("../../mail/repositories/pttAccountRepository", () => ({
  deletePttAccount: (...args: any[]) => mockDeletePttAccount(...args),
}));

jest.mock("../../mail/services/mailService", () => ({
  enqueueVerifyJob: (...args: any[]) => mockEnqueueVerifyJob(...args),
}));

jest.mock("../../mail/services/pttTerminal", () => ({
  sendPttMail: (...args: any[]) => mockTerminal(...args),
  verifyPttLogin: (...args: any[]) => mockTerminal(...args),
}));

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: (...a: any[]) => mockLogger.debug(...a),
    info: (...a: any[]) => mockLogger.info(...a),
    warn: (...a: any[]) => mockLogger.warn(...a),
    error: (...a: any[]) => mockLogger.error(...a),
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
  getSubscriptionById: (...args: any[]) => mockGetSubscriptionById(...args),
  setReplyContent: (...args: any[]) => mockSetReplyContent(...args),
  setReplyIncludeOriginal: (...args: any[]) => mockSetReplyIncludeOriginal(...args),
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
    isPrivate: true,
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

// ─── PTT mail: binding, settings, pending input ────────────────────────────

const PASSWORD = "S3cretPw";
const OWNER = { user: { id: "user-1" } };

function buildSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    userId: "user-1",
    board: "Gamesale",
    keyword: "ps5",
    replyContent: null,
    replyIncludeOriginal: false,
    ...overrides,
  };
}

function allLoggedText(): string {
  return JSON.stringify(
    [mockLogger.debug, mockLogger.info, mockLogger.warn, mockLogger.error].map((f) => f.mock.calls),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockConfig.mail.enabled = true;
  mockFindChannel.mockResolvedValue(OWNER);
});

describe("parseCommand (mail)", () => {
  it("parses 綁定PTT and 解除PTT", () => {
    expect(parseCommand("綁定PTT")).toEqual({ command: "bindPtt", args: "" });
    expect(parseCommand("解除ptt")).toEqual({ command: "unbindPtt", args: "" });
  });
});

describe("executeBindStart", () => {
  it("answers feature-off and stores nothing when mail is disabled", async () => {
    mockConfig.mail.enabled = false;
    const result = await executeBindStart(buildCtx());
    expect(result.reply).toContain("未啟用");
    expect(redisStore.size).toBe(0);
  });

  it("refuses outside a private chat and stores nothing", async () => {
    const result = await executeBindStart(buildCtx({ isPrivate: false }));
    expect(result.reply).toContain("私訊");
    expect(redisStore.size).toBe(0);
  });

  it("shows the disclaimer, asks for the ID and sets pending state", async () => {
    const result = await executeBindStart(buildCtx());
    expect(result.reply).toContain(PTT_DISCLAIMER);
    expect(result.reply).toContain("AES-256-GCM");
    expect(JSON.parse(redisStore.get("mail:pending:123") as string)).toEqual({ step: "bindId" });
  });
});

describe("bind flow", () => {
  async function toPasswordStep() {
    await executeBindStart(buildCtx());
    await handlePending(buildCtx({ text: "myPttId" }));
  }

  it.each(["guest", "NEW", "1abc", "a", "abcdefghijklm", "ab cd"])(
    "rejects the PTT id %s and keeps waiting for an id",
    async (id) => {
      await executeBindStart(buildCtx());
      const result = await handlePending(buildCtx({ text: id }));
      expect(result?.reply).toContain("格式不正確");
      expect(JSON.parse(redisStore.get("mail:pending:123") as string).step).toBe("bindId");
    },
  );

  it("accepts a valid id and moves to the password step", async () => {
    await toPasswordStep();
    expect(JSON.parse(redisStore.get("mail:pending:123") as string)).toEqual({
      step: "bindPassword",
      pttId: "myPttId",
    });
  });

  it("deletes the password message, enqueues ciphertext only and never calls the terminal", async () => {
    await toPasswordStep();
    const deleteInputMessage = jest.fn().mockResolvedValue(undefined);
    const result = await handlePending(buildCtx({ text: PASSWORD, deleteInputMessage }));

    expect(deleteInputMessage).toHaveBeenCalledTimes(1);
    expect(result?.reply).toContain("驗證中");
    expect(result?.reply).not.toContain(PASSWORD);
    expect(mockEnqueueVerifyJob).toHaveBeenCalledTimes(1);
    const job = mockEnqueueVerifyJob.mock.calls[0][0];
    expect(job).toEqual({
      userId: "user-1",
      chatId: "123",
      pttId: "myPttId",
      passwordEnc: expect.stringMatching(/^v1\./),
    });
    expect(JSON.stringify(job)).not.toContain(PASSWORD);
    expect(mockTerminal).not.toHaveBeenCalled();
    expect(redisStore.has("mail:pending:123")).toBe(false);
  });

  it("warns the user to delete the message when deletion fails", async () => {
    await toPasswordStep();
    const deleteInputMessage = jest.fn().mockRejectedValue(new Error("forbidden"));
    const result = await handlePending(buildCtx({ text: PASSWORD, deleteInputMessage }));

    expect(result?.reply).toContain(PASSWORD_DELETE_WARNING);
    expect(mockEnqueueVerifyJob).toHaveBeenCalledTimes(1);
  });

  it("never lets the password reach a logger, even when queueing fails", async () => {
    await toPasswordStep();
    mockEnqueueVerifyJob.mockRejectedValueOnce(new Error(`queue down ${PASSWORD}`));
    const result = await handlePending(
      buildCtx({ text: PASSWORD, deleteInputMessage: jest.fn().mockResolvedValue(undefined) }),
    );

    expect(result?.reply).toContain("伺服器錯誤");
    expect(allLoggedText()).not.toContain(PASSWORD);
  });

  it("encrypts the untrimmed message text as the password", async () => {
    await toPasswordStep();
    await handlePending(
      buildCtx({
        text: "pw 1",
        rawText: " pw 1 ",
        deleteInputMessage: jest.fn().mockResolvedValue(undefined),
      }),
    );
    const job = mockEnqueueVerifyJob.mock.calls[0][0];
    expect(decryptSecret(job.passwordEnc, mockConfig.mail.encryptKey)).toBe(" pw 1 ");
  });

  it("refuses the ID step outside a private chat and forgets the pending state", async () => {
    await executeBindStart(buildCtx());
    const result = await handlePending(buildCtx({ text: "myPttId", isPrivate: false }));
    expect(result?.reply).toContain("私訊");
    expect(redisStore.has("mail:pending:123")).toBe(false);
  });

  it("refuses the password step outside a private chat, deleting the message and queueing nothing", async () => {
    await toPasswordStep();
    const deleteInputMessage = jest.fn().mockResolvedValue(undefined);
    const result = await handlePending(
      buildCtx({ text: PASSWORD, isPrivate: false, deleteInputMessage }),
    );
    expect(result?.reply).toContain("私訊");
    expect(deleteInputMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueVerifyJob).not.toHaveBeenCalled();
    expect(redisStore.has("mail:pending:123")).toBe(false);
  });

  it.each(["熱門CANARYpw9", "新增CANARYpw9", "清單", "幫助", "綁定PTT"])(
    "the password step consumes %j as the password, never as a command",
    async (password) => {
      await toPasswordStep();
      const deleteInputMessage = jest.fn().mockResolvedValue(undefined);
      const result = await handlePending(buildCtx({ text: password, deleteInputMessage }));

      expect(result?.reply).toContain("驗證中");
      expect(result?.reply).not.toContain(password);
      expect(deleteInputMessage).toHaveBeenCalledTimes(1);
      expect(mockEnqueueVerifyJob).toHaveBeenCalledTimes(1);
      const job = mockEnqueueVerifyJob.mock.calls[0][0];
      expect(decryptSecret(job.passwordEnc, mockConfig.mail.encryptKey)).toBe(password);
      expect(JSON.stringify(job)).not.toContain(password);
      expect(mockCountByBoard).not.toHaveBeenCalled();
      expect(mockAddSubscription).not.toHaveBeenCalled();
      expect(redisStore.has("mail:pending:123")).toBe(false);
    },
  );

  it("the ID step consumes command words as invalid IDs and keeps waiting", async () => {
    await executeBindStart(buildCtx());
    const result = await handlePending(buildCtx({ text: "幫助" }));
    expect(result?.reply).toContain("格式不正確");
    expect(JSON.parse(redisStore.get("mail:pending:123") as string).step).toBe("bindId");
  });

  it("取消 abandons the bind at the ID step only", async () => {
    await executeBindStart(buildCtx());
    const result = await handlePending(buildCtx({ text: "取消" }));
    expect(result?.reply).toContain("取消");
    expect(redisStore.has("mail:pending:123")).toBe(false);

    await toPasswordStep();
    const deleteInputMessage = jest.fn().mockResolvedValue(undefined);
    await handlePending(buildCtx({ text: "取消", deleteInputMessage }));
    expect(mockEnqueueVerifyJob).toHaveBeenCalledTimes(1);
  });

  it("the password prompt says that waiting cancels", async () => {
    await executeBindStart(buildCtx());
    const result = await handlePending(buildCtx({ text: "myPttId" }));
    expect(result?.reply).toContain("5 分鐘");
  });

  it("a reply-text wait is still cleared by a command, which then runs normally", async () => {
    redisStore.set("mail:pending:123", JSON.stringify({ step: "replyText", subscriptionId: "x" }));
    expect(await handlePending(buildCtx({ text: "幫助" }))).toBeNull();
    expect(redisStore.has("mail:pending:123")).toBe(false);
  });

  it("returns null when nothing is pending", async () => {
    expect(await handlePending(buildCtx({ text: "hello" }))).toBeNull();
  });
});

describe("executeUnbind", () => {
  it("deletes the account and confirms", async () => {
    mockDeletePttAccount.mockResolvedValue(true);
    const result = await executeUnbind(buildCtx());
    expect(mockDeletePttAccount).toHaveBeenCalledWith("user-1");
    expect(result.reply).toContain("已刪除");
  });

  it("says so when no account was bound", async () => {
    mockDeletePttAccount.mockResolvedValue(false);
    const result = await executeUnbind(buildCtx());
    expect(result.reply).toContain("沒有綁定");
  });
});

describe("settings card actions", () => {
  it("open shows board, keyword, 未設定 and the buttons", async () => {
    mockGetSubscriptionById.mockResolvedValue(buildSub());
    const result = await executeSubAction(buildCtx(), "sub-1", "open");
    expect(result.reply).toContain("Gamesale");
    expect(result.reply).toContain("ps5");
    expect(result.reply).toContain("未設定");
    expect(result.buttons?.flat().map((b) => b.action)).toEqual([
      "sub:sub-1:reply",
      "sub:sub-1:orig",
      "sub:sub-1:clear",
    ]);
    expect(result.edit).toBe(false);
  });

  it("reply sets pending state, and the next text saves it and shows the card", async () => {
    mockGetSubscriptionById.mockResolvedValue(buildSub());
    await executeSubAction(buildCtx(), "sub-1", "reply");
    expect(JSON.parse(redisStore.get("mail:pending:123") as string)).toEqual({
      step: "replyText",
      subscriptionId: "sub-1",
    });

    mockSetReplyContent.mockResolvedValue(buildSub({ replyContent: "你好，請問還在嗎" }));
    const result = await handlePending(buildCtx({ text: "你好，請問還在嗎" }));
    expect(mockSetReplyContent).toHaveBeenCalledWith("sub-1", "你好，請問還在嗎");
    expect(result?.reply).toContain("你好，請問還在嗎");
    expect(redisStore.has("mail:pending:123")).toBe(false);
  });

  it("caps the reply length and keeps waiting", async () => {
    mockGetSubscriptionById.mockResolvedValue(buildSub());
    await executeSubAction(buildCtx(), "sub-1", "reply");
    const result = await handlePending(buildCtx({ text: "a".repeat(2001) }));
    expect(result?.reply).toContain("太長");
    expect(mockSetReplyContent).not.toHaveBeenCalled();
    expect(redisStore.has("mail:pending:123")).toBe(true);
  });

  it("orig toggles the flag", async () => {
    mockGetSubscriptionById.mockResolvedValue(buildSub());
    mockSetReplyIncludeOriginal.mockResolvedValue(buildSub({ replyIncludeOriginal: true }));
    const result = await executeSubAction(buildCtx(), "sub-1", "orig");
    expect(mockSetReplyIncludeOriginal).toHaveBeenCalledWith("sub-1", true);
    expect(result.reply).toContain("附原文：開");
  });

  it("clear removes the reply text", async () => {
    mockGetSubscriptionById.mockResolvedValue(buildSub({ replyContent: "hi" }));
    mockSetReplyContent.mockResolvedValue(buildSub());
    const result = await executeSubAction(buildCtx(), "sub-1", "clear");
    expect(mockSetReplyContent).toHaveBeenCalledWith("sub-1", null);
    expect(result.reply).toContain("未設定");
  });

  it.each(["open", "reply", "orig", "clear"])(
    "refuses %s on another user's subscription",
    async (action) => {
      mockGetSubscriptionById.mockResolvedValue(buildSub({ userId: "someone-else" }));
      const result = await executeSubAction(buildCtx(), "sub-1", action);
      expect(result.reply).toContain("找不到");
      expect(mockSetReplyContent).not.toHaveBeenCalled();
      expect(mockSetReplyIncludeOriginal).not.toHaveBeenCalled();
      expect(redisStore.size).toBe(0);
    },
  );

  it("refuses a saved reply text when the pending subscription is not the user's", async () => {
    redisStore.set("mail:pending:123", JSON.stringify({ step: "replyText", subscriptionId: "x" }));
    mockGetSubscriptionById.mockResolvedValue(buildSub({ userId: "someone-else" }));
    const result = await handlePending(buildCtx({ text: "hello" }));
    expect(result?.reply).toContain("找不到");
    expect(mockSetReplyContent).not.toHaveBeenCalled();
  });

  it("answers feature-off when mail is disabled", async () => {
    mockConfig.mail.enabled = false;
    const result = await executeSubAction(buildCtx(), "sub-1", "orig");
    expect(result.reply).toContain("未啟用");
    expect(mockGetSubscriptionById).not.toHaveBeenCalled();
  });
});

describe("buttons on 新增 and 清單", () => {
  it("新增 success returns the card buttons of the new subscription", async () => {
    mockResolveBoard.mockResolvedValue("Gamesale");
    mockSubscriptionExists.mockResolvedValue(false);
    mockAddSubscription.mockResolvedValue(buildSub({ id: "new-sub" }));
    const result = await executeAdd(buildCtx(), "Gamesale ps5");
    expect(result.buttons?.flat().map((b) => b.action)).toContain("sub:new-sub:reply");
  });

  it("清單 keeps the grouped text and adds one open button per subscription", async () => {
    mockGetSubscriptions.mockResolvedValue([
      buildSub(),
      buildSub({ id: "sub-2", keyword: "switch" }),
    ]);
    const result = await executeList(buildCtx());
    expect(result.reply).toContain("📌 Gamesale");
    expect(result.buttons?.map((row) => row[0]!.action)).toEqual([
      "sub:sub-1:open",
      "sub:sub-2:open",
    ]);
  });

  it("cuts a long button label by code points, never inside a surrogate pair", async () => {
    mockGetSubscriptions.mockResolvedValue([buildSub({ keyword: "😀".repeat(60) })]);
    const label = (await executeList(buildCtx())).buttons![0]![0]!.text;
    expect(Array.from(label)).toHaveLength(40);
    expect(label).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("offers no buttons when mail is disabled", async () => {
    mockConfig.mail.enabled = false;
    mockGetSubscriptions.mockResolvedValue([buildSub()]);
    expect((await executeList(buildCtx())).buttons).toBeUndefined();
  });
});
