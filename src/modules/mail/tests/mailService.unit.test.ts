/**
 * Unit tests for mailService.
 *
 * Covers the mail layout, eligibility and offers, the claim hand-off, the send and verify jobs
 * (outcomes, wrong password, no secret in logs) and startup recovery.
 */

import { encryptSecret } from "../../../core/crypto";
import { ARTICLE_DELETED, fetchDetail } from "../../board/services/detailFetcher";
import { findSubscription } from "../../user/repositories/subscriptionRepository";
import * as mailRequests from "../repositories/mailRequestRepository";
import * as pttAccounts from "../repositories/pttAccountRepository";
import {
  buildMail,
  describeRequestOutcome,
  executeSendJob,
  executeVerifyJob,
  offerMail,
  recordNotificationMessage,
  recoverInFlight,
  requestMail,
} from "../services/mailService";
import { PttError, sendPttMail, verifyPttLogin } from "../services/pttTerminal";
import { mailQueue } from "../workers/mailQueue";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const KEY = Buffer.alloc(32, 7).toString("base64");
const PASSWORD = "s3cret-Passw0rd!";

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// Delegating wrappers: the real pttTerminal creates its logger while the module graph loads,
// before mockLogger is initialised.
jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: (...a: unknown[]) => mockLogger.debug(...a),
    info: (...a: unknown[]) => mockLogger.info(...a),
    warn: (...a: unknown[]) => mockLogger.warn(...a),
    error: (...a: unknown[]) => mockLogger.error(...a),
  }),
}));
jest.mock("../../../core/config", () => ({
  config: {
    mail: { enabled: true, dailyLimit: 20, encryptKey: Buffer.alloc(32, 7).toString("base64") },
  },
}));
jest.mock("../../board/repositories/articleRepository", () => ({
  getArticleForMail: jest.fn(),
}));
jest.mock("../../board/services/detailFetcher", () => ({
  ARTICLE_DELETED: Symbol("ARTICLE_DELETED"),
  fetchDetail: jest.fn(),
}));
jest.mock("../../user/repositories/subscriptionRepository", () => ({
  findSubscription: jest.fn(),
}));
jest.mock("../repositories/mailRequestRepository", () => ({
  MAX_MAIL_ATTEMPTS: 3,
  upsertOffer: jest.fn(),
  setMessageRef: jest.fn(),
  getMailRequest: jest.fn(),
  claim: jest.fn(),
  markSending: jest.fn(),
  markSent: jest.fn(),
  markFailed: jest.fn(),
  markUnknown: jest.fn(),
  findInFlight: jest.fn(),
}));
jest.mock("../repositories/pttAccountRepository", () => ({
  getPttAccount: jest.fn(),
  upsertPttAccount: jest.fn(),
  markPttAccountInvalid: jest.fn(),
}));
jest.mock("../services/pttTerminal", () => ({
  ...jest.requireActual("../services/pttTerminal"),
  sendPttMail: jest.fn(),
  verifyPttLogin: jest.fn(),
}));
jest.mock("../workers/mailQueue", () => ({
  SEND_JOB: "send",
  VERIFY_JOB: "verify",
  mailQueue: { add: jest.fn() },
}));

const mockAdapter = {
  platform: "TELEGRAM" as const,
  sendReply: jest.fn(),
  sendNotification: jest.fn(),
  sendAlert: jest.fn(),
  updateMessage: jest.fn(),
  rateLimit: { max: 30, duration: 1_000 },
};
jest.mock("../../broadcast/registry", () => ({ getAdapter: () => mockAdapter }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getArticleForMail } = require("../../board/repositories/articleRepository") as {
  getArticleForMail: jest.Mock;
};

const repo = mailRequests as jest.Mocked<typeof mailRequests>;
const accounts = pttAccounts as jest.Mocked<typeof pttAccounts>;
const mockFindSub = findSubscription as jest.Mock;
const mockSend = sendPttMail as jest.Mock;
const mockVerify = verifyPttLogin as jest.Mock;
const mockFetchDetail = fetchDetail as jest.Mock;
const mockAdd = mailQueue.add as jest.Mock;

// ─── Helpers ────────────────────────────────────────────────────────────────

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    userId: "user-1",
    board: "Lifeismoney",
    articleCode: "M.1.A.001",
    author: "seller",
    title: "[情報] 好康",
    keyword: "好康",
    status: "QUEUED",
    error: null,
    chatId: "chat-1",
    messageId: "msg-1",
    attempts: 1,
    ...overrides,
  } as never;
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    replyContent: "你好，請問還在嗎？",
    replyIncludeOriginal: false,
    ...overrides,
  } as never;
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    pttId: "myid",
    passwordEnc: encryptSecret(PASSWORD, KEY),
    invalidAt: null,
    ...overrides,
  } as never;
}

function payload() {
  return {
    userId: "user-1",
    keyword: "好康",
    articleCode: "M.1.A.001",
    board: "Lifeismoney",
    title: "[情報] 好康",
    author: "seller",
    pushSum: 0,
    link: "https://www.ptt.cc/bbs/Lifeismoney/M.1.A.001.html",
  };
}

function loggedText(): string {
  return JSON.stringify(
    [mockLogger.debug, mockLogger.info, mockLogger.warn, mockLogger.error].map((f) => f.mock.calls),
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  repo.markSending.mockResolvedValue(true);
  repo.markFailed.mockResolvedValue(true);
  repo.markUnknown.mockResolvedValue(true);
  repo.markSent.mockResolvedValue(true);
  mockAdd.mockResolvedValue(undefined);
  mockAdapter.sendReply.mockResolvedValue(undefined);
  mockAdapter.updateMessage.mockResolvedValue(undefined);
});

// ─── buildMail ──────────────────────────────────────────────────────────────

describe("buildMail", () => {
  it("uses Re: title and the reply text alone when the original is off", () => {
    const mail = buildMail(request(), subscription(), "article text");
    expect(mail).toEqual({
      to: "seller",
      subject: "Re: [情報] 好康",
      body: "你好，請問還在嗎？",
      originalMissing: false,
    });
  });

  it("appends the PTT-style quote with every line prefixed", () => {
    const mail = buildMail(
      request(),
      subscription({ replyIncludeOriginal: true }),
      "第一行\n\n第三行\n",
    );
    expect(mail.body).toBe(
      "你好，請問還在嗎？\n\n※ 引述《seller》之銘言：\n: 第一行\n: \n: 第三行",
    );
    expect(mail.originalMissing).toBe(false);
  });

  it("sends without the quote and flags it when the text is unavailable", () => {
    const mail = buildMail(request(), subscription({ replyIncludeOriginal: true }), null);
    expect(mail.body).toBe("你好，請問還在嗎？");
    expect(mail.originalMissing).toBe(true);
  });
});

// ─── offerMail ──────────────────────────────────────────────────────────────

describe("offerMail", () => {
  beforeEach(() => {
    mockFindSub.mockResolvedValue(subscription());
    accounts.getPttAccount.mockResolvedValue(account());
  });

  it("returns the request id for a fresh offer", async () => {
    repo.upsertOffer.mockResolvedValue(request({ status: "OFFERED", attempts: 0 }));
    await expect(offerMail(payload())).resolves.toBe("req-1");
  });

  it("returns null when the request is already past OFFERED", async () => {
    repo.upsertOffer.mockResolvedValue(request({ status: "SENT" }));
    await expect(offerMail(payload())).resolves.toBeNull();
  });

  it("offers a FAILED request only while attempts remain", async () => {
    repo.upsertOffer.mockResolvedValue(request({ status: "FAILED", attempts: 1 }));
    await expect(offerMail(payload())).resolves.toBe("req-1");
    repo.upsertOffer.mockResolvedValue(request({ status: "FAILED", attempts: 3 }));
    await expect(offerMail(payload())).resolves.toBeNull();
  });

  it.each([
    ["no reply text", () => mockFindSub.mockResolvedValue(subscription({ replyContent: " " }))],
    ["no account", () => accounts.getPttAccount.mockResolvedValue(null)],
    [
      "invalid account",
      () => accounts.getPttAccount.mockResolvedValue(account({ invalidAt: new Date() })),
    ],
  ])("returns null with %s", async (_name, arrange) => {
    arrange();
    await expect(offerMail(payload())).resolves.toBeNull();
    expect(repo.upsertOffer).not.toHaveBeenCalled();
  });

  it("gives no button to a notification of another keyword than the request's", async () => {
    repo.upsertOffer.mockResolvedValue(
      request({ status: "OFFERED", attempts: 0, keyword: "other" }),
    );
    await expect(offerMail(payload())).resolves.toBeNull();
    repo.upsertOffer.mockResolvedValue(
      request({ status: "FAILED", attempts: 1, keyword: "other" }),
    );
    await expect(offerMail(payload())).resolves.toBeNull();
  });

  it("returns null without an author", async () => {
    await expect(offerMail({ ...payload(), author: null })).resolves.toBeNull();
  });
});

// ─── requestMail ────────────────────────────────────────────────────────────

describe("requestMail", () => {
  beforeEach(() => {
    accounts.getPttAccount.mockResolvedValue(account());
  });

  it("enqueues one send job for a claimed request", async () => {
    repo.claim.mockResolvedValue({ kind: "claimed", request: request() });
    const out = await requestMail("req-1", "user-1");
    expect(out.kind).toBe("queued");
    expect(mockAdd).toHaveBeenCalledWith("send", { requestId: "req-1" }, { jobId: "send-req-1-1" });
  });

  it("refuses a second claim and enqueues nothing", async () => {
    repo.claim.mockResolvedValue({ kind: "not_claimable", status: "QUEUED" });
    const out = await requestMail("req-1", "user-1");
    expect(out).toEqual({ kind: "not_claimable", status: "QUEUED" });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("surfaces the daily cap", async () => {
    repo.claim.mockResolvedValue({ kind: "cap_reached", limit: 20 });
    const out = await requestMail("req-1", "user-1");
    expect(out).toEqual({ kind: "cap_reached", limit: 20 });
    expect(describeRequestOutcome(out as never)).toContain("20");
  });

  it("refuses another user's request", async () => {
    repo.claim.mockResolvedValue({ kind: "not_owner" });
    await expect(requestMail("req-1", "user-2")).resolves.toEqual({ kind: "not_owner" });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("does not claim for an account known to be invalid", async () => {
    accounts.getPttAccount.mockResolvedValue(account({ invalidAt: new Date() }));
    await expect(requestMail("req-1", "user-1")).resolves.toEqual({ kind: "account_invalid" });
    expect(repo.claim).not.toHaveBeenCalled();
  });

  it("stores the tapped message before the send job exists when the request has none", async () => {
    repo.claim.mockResolvedValue({
      kind: "claimed",
      request: request({ chatId: null, messageId: null }),
    });
    const order: string[] = [];
    repo.setMessageRef.mockImplementation(async () => void order.push("store"));
    mockAdd.mockImplementation(async () => void order.push("enqueue"));
    const ref = { chatId: "555", messageId: "77" };
    const out = await requestMail("req-1", "user-1", ref);
    expect(order).toEqual(["store", "enqueue"]);
    expect(repo.setMessageRef).toHaveBeenCalledWith("req-1", "555", "77");
    expect(out).toMatchObject({ kind: "queued", request: ref });
  });

  it("leaves a stored message alone and still enqueues when the store fails", async () => {
    repo.claim.mockResolvedValue({ kind: "claimed", request: request() });
    await requestMail("req-1", "user-1", { chatId: "555", messageId: "77" });
    expect(repo.setMessageRef).not.toHaveBeenCalled();

    repo.claim.mockResolvedValue({
      kind: "claimed",
      request: request({ chatId: null, messageId: null }),
    });
    repo.setMessageRef.mockRejectedValue(new Error("db down"));
    const out = await requestMail("req-1", "user-1", { chatId: "555", messageId: "77" });
    expect(out.kind).toBe("queued");
    expect(mockAdd).toHaveBeenCalledTimes(2);
  });

  it("fails the row when the queue is unreachable", async () => {
    repo.claim.mockResolvedValue({ kind: "claimed", request: request() });
    mockAdd.mockRejectedValue(new Error("redis down"));
    await expect(requestMail("req-1", "user-1")).resolves.toEqual({ kind: "enqueue_failed" });
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.any(String));
  });
});

// ─── executeSendJob ─────────────────────────────────────────────────────────

describe("executeSendJob", () => {
  beforeEach(() => {
    repo.getMailRequest.mockResolvedValue(request());
    mockFindSub.mockResolvedValue(subscription());
    accounts.getPttAccount.mockResolvedValue(account());
  });

  it("sends with the decrypted password and marks SENT", async () => {
    mockSend.mockResolvedValue({ outcome: "sent" });
    await executeSendJob("req-1");
    expect(mockSend).toHaveBeenCalledWith({
      pttId: "myid",
      password: PASSWORD,
      to: "seller",
      subject: "Re: [情報] 好康",
      body: "你好，請問還在嗎？",
    });
    expect(repo.markSent).toHaveBeenCalledWith("req-1");
    expect(mockAdapter.updateMessage).toHaveBeenCalledWith(
      { chatId: "chat-1", messageId: "msg-1" },
      expect.stringContaining("已寄給 seller"),
      undefined,
    );
  });

  it("quotes the stored article content", async () => {
    mockFindSub.mockResolvedValue(subscription({ replyIncludeOriginal: true }));
    getArticleForMail.mockResolvedValue({ content: "原文", link: "https://x" });
    mockSend.mockResolvedValue({ outcome: "sent" });
    await executeSendJob("req-1");
    expect(mockSend.mock.calls[0][0].body).toContain(": 原文");
    expect(mockFetchDetail).not.toHaveBeenCalled();
  });

  it("fetches the article fresh when no content is stored", async () => {
    mockFindSub.mockResolvedValue(subscription({ replyIncludeOriginal: true }));
    getArticleForMail.mockResolvedValue({ content: null, link: "https://x" });
    mockFetchDetail.mockResolvedValue({ content: "新抓的內文" });
    mockSend.mockResolvedValue({ outcome: "sent" });
    await executeSendJob("req-1");
    expect(mockSend.mock.calls[0][0].body).toContain(": 新抓的內文");
  });

  it("sends without the quote for a deleted article and says so", async () => {
    mockFindSub.mockResolvedValue(subscription({ replyIncludeOriginal: true }));
    getArticleForMail.mockResolvedValue({ content: null, link: "https://x" });
    mockFetchDetail.mockResolvedValue(ARTICLE_DELETED);
    mockSend.mockResolvedValue({ outcome: "sent" });
    await executeSendJob("req-1");
    expect(mockSend.mock.calls[0][0].body).toBe("你好，請問還在嗎？");
    expect(mockAdapter.updateMessage.mock.calls[0][1]).toContain("未附上引文");
  });

  it("returns not_sent to FAILED and offers the retry button", async () => {
    mockSend.mockResolvedValue({ outcome: "not_sent", errorCode: "Timeout" });
    await executeSendJob("req-1");
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.any(String));
    expect(mockAdapter.updateMessage).toHaveBeenCalledWith(
      { chatId: "chat-1", messageId: "msg-1" },
      expect.any(String),
      [[{ text: "✉️ 再試一次", action: "mail:req-1" }]],
    );
  });

  it("drops the retry button when attempts are used up", async () => {
    repo.getMailRequest.mockResolvedValue(request({ attempts: 3 }));
    mockSend.mockResolvedValue({ outcome: "not_sent", errorCode: "Timeout" });
    await executeSendJob("req-1");
    expect(mockAdapter.updateMessage.mock.calls[0][2]).toBeUndefined();
  });

  it("marks unknown with no button and never FAILED", async () => {
    mockSend.mockResolvedValue({ outcome: "unknown", errorCode: "Timeout" });
    await executeSendJob("req-1");
    expect(repo.markUnknown).toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(mockAdapter.updateMessage.mock.calls[0][2]).toBeUndefined();
    expect(mockAdapter.updateMessage.mock.calls[0][1]).toContain("PTT 信箱");
  });

  it("marks the account invalid on a wrong password and hints to rebind", async () => {
    mockSend.mockResolvedValue({ outcome: "not_sent", errorCode: "WrongPassword" });
    await executeSendJob("req-1");
    expect(accounts.markPttAccountInvalid).toHaveBeenCalledWith("user-1");
    expect(repo.markFailed).toHaveBeenCalled();
    expect(mockAdapter.updateMessage.mock.calls[0][1]).toContain("綁定PTT");
    expect(mockAdapter.updateMessage.mock.calls[0][2]).toBeUndefined();
  });

  it("reports two-factor accounts as unsupported", async () => {
    mockSend.mockResolvedValue({ outcome: "not_sent", errorCode: "TwoFactorRequired" });
    await executeSendJob("req-1");
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.stringContaining("兩步驟"));
  });

  it("does nothing when the row is no longer QUEUED", async () => {
    repo.markSending.mockResolvedValue(false);
    await executeSendJob("req-1");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails the row and tells the user when markSending throws", async () => {
    repo.markSending.mockRejectedValue(new Error("db down"));
    await executeSendJob("req-1");
    expect(mockSend).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.any(String));
    expect(mockAdapter.updateMessage).toHaveBeenCalledWith(
      { chatId: "chat-1", messageId: "msg-1" },
      expect.stringContaining("寄信失敗"),
      [[{ text: "✉️ 再試一次", action: "mail:req-1" }]],
    );
  });

  it("survives getMailRequest throwing: marks FAILED and reports when the row can be read again", async () => {
    repo.getMailRequest.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(request());
    await executeSendJob("req-1");
    expect(mockSend).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.any(String));
    expect(mockAdapter.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when markFailed did not move the row", async () => {
    repo.markSending.mockRejectedValue(new Error("db down"));
    repo.markFailed.mockResolvedValue(false);
    await executeSendJob("req-1");
    expect(mockAdapter.updateMessage).not.toHaveBeenCalled();
    expect(mockAdapter.sendReply).not.toHaveBeenCalled();
  });

  it("gives up quietly when the database stays down", async () => {
    repo.getMailRequest.mockRejectedValue(new Error("db down"));
    repo.markFailed.mockRejectedValue(new Error("db down"));
    await expect(executeSendJob("req-1")).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAdapter.updateMessage).not.toHaveBeenCalled();
  });

  it("maps an unfinished PTT draft to FAILED with the draft advice", async () => {
    mockSend.mockResolvedValue({ outcome: "not_sent", errorCode: "UnfinishedDraft" });
    await executeSendJob("req-1");
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.stringContaining("草稿"));
  });

  it("maps too many PTT sessions to FAILED with the log-out advice", async () => {
    mockSend.mockResolvedValue({ outcome: "not_sent", errorCode: "TooManySessions" });
    await executeSendJob("req-1");
    expect(repo.markFailed).toHaveBeenCalledWith("req-1", expect.stringContaining("連線太多"));
  });

  it("falls back to sendReply when the adapter cannot edit", async () => {
    mockSend.mockResolvedValue({ outcome: "sent" });
    mockAdapter.updateMessage.mockRejectedValue(new Error("message to edit not found"));
    await executeSendJob("req-1");
    expect(mockAdapter.sendReply).toHaveBeenCalledWith("chat-1", expect.stringContaining("已寄給"));
  });

  it("never logs the password, even when the client fails", async () => {
    mockSend.mockResolvedValueOnce({ outcome: "sent" });
    await executeSendJob("req-1");
    mockSend.mockRejectedValueOnce(new Error("boom"));
    await executeSendJob("req-1");
    mockSend.mockResolvedValueOnce({ outcome: "not_sent", errorCode: "WrongPassword" });
    await executeSendJob("req-1");
    expect(repo.markUnknown).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain(KEY);
  });
});

// ─── executeVerifyJob ───────────────────────────────────────────────────────

describe("executeVerifyJob", () => {
  const data = () => ({
    userId: "user-1",
    chatId: "chat-1",
    pttId: "myid",
    passwordEnc: encryptSecret(PASSWORD, KEY),
  });

  it("saves the account with the ciphertext as given and replies", async () => {
    mockVerify.mockResolvedValue(undefined);
    const job = data();
    await executeVerifyJob(job);
    expect(mockVerify).toHaveBeenCalledWith("myid", PASSWORD);
    expect(accounts.upsertPttAccount).toHaveBeenCalledWith("user-1", "myid", job.passwordEnc);
    expect(mockAdapter.sendReply).toHaveBeenCalledWith("chat-1", expect.stringContaining("myid"));
  });

  it("does not save on a wrong password and asks for a rebind", async () => {
    mockVerify.mockRejectedValue(new PttError("WrongPassword"));
    await executeVerifyJob(data());
    expect(accounts.upsertPttAccount).not.toHaveBeenCalled();
    expect(mockAdapter.sendReply.mock.calls[0][1]).toContain("綁定PTT");
  });

  it("reports two-factor accounts as unsupported", async () => {
    mockVerify.mockRejectedValue(new PttError("TwoFactorRequired"));
    await executeVerifyJob(data());
    expect(mockAdapter.sendReply.mock.calls[0][1]).toContain("兩步驟");
  });

  it("tells the user to deal with the unfinished PTT draft", async () => {
    mockVerify.mockRejectedValue(new PttError("UnfinishedDraft"));
    await executeVerifyJob(data());
    expect(accounts.upsertPttAccount).not.toHaveBeenCalled();
    expect(mockAdapter.sendReply.mock.calls[0][1]).toContain("草稿");
  });

  it("never logs the password", async () => {
    mockVerify.mockRejectedValueOnce(new PttError("Timeout"));
    await executeVerifyJob(data());
    mockVerify.mockRejectedValueOnce(new Error("unexpected"));
    await executeVerifyJob(data());
    mockVerify.mockResolvedValueOnce(undefined);
    await executeVerifyJob(data());
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain(KEY);
  });
});

describe("recordNotificationMessage", () => {
  it("stores the message reference on the request", async () => {
    await recordNotificationMessage("req-1", { chatId: "c", messageId: "m" });
    expect(repo.setMessageRef).toHaveBeenCalledWith("req-1", "c", "m");
  });
});

// ─── recoverInFlight ────────────────────────────────────────────────────────

describe("recoverInFlight", () => {
  it("re-enqueues QUEUED rows and turns SENDING into UNKNOWN with a report", async () => {
    repo.findInFlight.mockResolvedValue([
      request({ id: "q1", status: "QUEUED", attempts: 2 }),
      request({ id: "s1", status: "SENDING" }),
    ]);
    const out = await recoverInFlight();
    expect(out).toEqual({ requeued: 1, unknown: 1 });
    expect(mockAdd).toHaveBeenCalledWith("send", { requestId: "q1" }, { jobId: "send-q1-2" });
    expect(repo.markUnknown).toHaveBeenCalledWith("s1", expect.any(String));
    expect(mockAdapter.updateMessage.mock.calls[0][1]).toContain("PTT 信箱");
  });
});
