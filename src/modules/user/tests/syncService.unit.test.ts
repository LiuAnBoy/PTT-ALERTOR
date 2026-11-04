import { createMockRedis } from "../../../__mocks__/mockRedis";

const mockRedis = createMockRedis();
const mockPrisma = {
  subscription: { findMany: jest.fn() },
  article: { findMany: jest.fn(), groupBy: jest.fn() },
};

jest.mock("../../../core/redis", () => ({ redis: mockRedis }));
jest.mock("../../../core/prisma", () => ({ getPrisma: () => mockPrisma }));
jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock("../../board/services/articleCache", () => ({
  hasLatestTimestamp: jest.fn(),
  addActiveArticles: jest.fn().mockResolvedValue(undefined),
  setLatestTimestamp: jest.fn().mockResolvedValue(undefined),
  removeLatestTimestamp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../board/services/crawlerService", () => ({
  seedBoardBaseline: jest.fn().mockResolvedValue(0),
}));

import {
  addActiveArticles,
  hasLatestTimestamp,
  removeLatestTimestamp,
  setLatestTimestamp,
} from "../../board/services/articleCache";
import { seedBoardBaseline } from "../../board/services/crawlerService";
import {
  addSubscriptionToRedis,
  removeSubscriptionFromRedis,
  seedArticleCache,
  syncSubscriptions,
} from "../services/syncService";

const pipe = mockRedis._mockPipeline;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// syncSubscriptions
// ---------------------------------------------------------------------------
describe("syncSubscriptions", () => {
  it("should build pipeline with correct del/sadd calls for non-empty subscriptions", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { userId: "u1", board: "Gossiping", keyword: "covid" },
    ]);

    await syncSubscriptions();

    // Pipeline must be created
    expect(mockRedis.pipeline).toHaveBeenCalled();

    // Should delete old boards key and the board-specific subs key
    expect(pipe.del).toHaveBeenCalledWith("boards");
    expect(pipe.del).toHaveBeenCalledWith("keyword:Gossiping:subs");

    // Should add board to boards set
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Gossiping");

    // Should add user to board subscriber set
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");

    // Should delete then add user keyword set
    expect(pipe.del).toHaveBeenCalledWith("user:u1:board:Gossiping");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");

    // Pipeline must be executed
    expect(pipe.exec).toHaveBeenCalled();
  });

  it("should return early without creating a pipeline when subscriptions are empty", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([]);

    await syncSubscriptions();

    expect(mockRedis.pipeline).not.toHaveBeenCalled();
    expect(pipe.exec).not.toHaveBeenCalled();
  });

  it("should correctly group multiple boards and multiple users in the pipeline", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { userId: "u1", board: "Gossiping", keyword: "covid" },
      { userId: "u1", board: "Gossiping", keyword: "vaccine" },
      { userId: "u2", board: "Gossiping", keyword: "covid" },
      { userId: "u1", board: "Stock", keyword: "TSMC" },
    ]);

    await syncSubscriptions();

    // Both boards should be added
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Gossiping", "Stock");

    // Board subscriber sets should contain the correct users
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1", "u2");
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Stock:subs", "u1");

    // User keyword sets should be grouped correctly
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid", "vaccine");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u2:board:Gossiping", "covid");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Stock", "TSMC");

    // Old keys should be cleaned up
    expect(pipe.del).toHaveBeenCalledWith("keyword:Gossiping:subs");
    expect(pipe.del).toHaveBeenCalledWith("keyword:Stock:subs");
    expect(pipe.del).toHaveBeenCalledWith("user:u1:board:Gossiping");
    expect(pipe.del).toHaveBeenCalledWith("user:u2:board:Gossiping");
    expect(pipe.del).toHaveBeenCalledWith("user:u1:board:Stock");

    expect(pipe.exec).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// seedArticleCache
// ---------------------------------------------------------------------------
describe("seedArticleCache", () => {
  it("should skip when no boards exist", async () => {
    mockRedis.smembers.mockResolvedValueOnce([]);

    await seedArticleCache();

    expect(mockPrisma.article.groupBy).not.toHaveBeenCalled();
    expect(mockPrisma.article.findMany).not.toHaveBeenCalled();
  });

  it("should write nothing when the DB has no articles for the boards", async () => {
    mockRedis.smembers.mockResolvedValueOnce(["Gossiping"]);
    mockPrisma.article.groupBy.mockResolvedValueOnce([]);
    mockPrisma.article.findMany.mockResolvedValueOnce([]);

    await seedArticleCache();

    expect(setLatestTimestamp).not.toHaveBeenCalled();
    expect(addActiveArticles).toHaveBeenCalledWith([]);
  });

  it("should seed the newest article per board and the 24-hour active set", async () => {
    mockRedis.smembers.mockResolvedValueOnce(["Gossiping", "Stock"]);
    mockPrisma.article.groupBy.mockResolvedValueOnce([
      { board: "Gossiping", _max: { timestamp: BigInt(200) } },
      { board: "Stock", _max: { timestamp: BigInt(150) } },
    ]);
    mockPrisma.article.findMany.mockResolvedValueOnce([
      { code: "M.001", board: "Gossiping", timestamp: BigInt(100) },
      { code: "M.002", board: "Gossiping", timestamp: BigInt(200) },
      { code: "M.100", board: "Stock", timestamp: BigInt(150) },
    ]);

    await seedArticleCache();

    expect(setLatestTimestamp).toHaveBeenCalledWith("Gossiping", 200);
    expect(setLatestTimestamp).toHaveBeenCalledWith("Stock", 150);
    expect(addActiveArticles).toHaveBeenCalledWith([
      { board: "Gossiping", code: "M.001", timestamp: 100 },
      { board: "Gossiping", code: "M.002", timestamp: 200 },
      { board: "Stock", code: "M.100", timestamp: 150 },
    ]);
  });

  it("should keep the baseline of a quiet board with no article in the last 24 hours", async () => {
    mockRedis.smembers.mockResolvedValueOnce(["Soho"]);
    mockPrisma.article.groupBy.mockResolvedValueOnce([
      { board: "Soho", _max: { timestamp: BigInt(100) } },
    ]);
    mockPrisma.article.findMany.mockResolvedValueOnce([]);

    await seedArticleCache();

    expect(setLatestTimestamp).toHaveBeenCalledWith("Soho", 100);
    expect(addActiveArticles).toHaveBeenCalledWith([]);
  });
});

// ---------------------------------------------------------------------------
// addSubscriptionToRedis
// ---------------------------------------------------------------------------
describe("addSubscriptionToRedis", () => {
  it("should seed the baseline when board has no latest timestamp, then add keys to Redis", async () => {
    (hasLatestTimestamp as jest.Mock).mockResolvedValue(false);

    await addSubscriptionToRedis("u1", "Gossiping", "covid");

    expect(hasLatestTimestamp).toHaveBeenCalledWith("Gossiping");
    expect(seedBoardBaseline).toHaveBeenCalledWith("Gossiping");

    // Should still add to Redis via pipeline
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Gossiping");
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    expect(pipe.exec).toHaveBeenCalled();
  });

  it("should skip seeding when board already has latest timestamp", async () => {
    (hasLatestTimestamp as jest.Mock).mockResolvedValue(true);

    await addSubscriptionToRedis("u1", "Stock", "TSMC");

    expect(hasLatestTimestamp).toHaveBeenCalledWith("Stock");
    expect(seedBoardBaseline).not.toHaveBeenCalled();

    // Redis keys should still be set
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Stock");
    expect(pipe.exec).toHaveBeenCalled();
  });

  it("should warn and continue adding to Redis when seeding throws", async () => {
    (hasLatestTimestamp as jest.Mock).mockResolvedValue(false);
    (seedBoardBaseline as jest.Mock).mockRejectedValueOnce(new Error("network error"));

    await addSubscriptionToRedis("u1", "Gossiping", "covid");

    expect(seedBoardBaseline).toHaveBeenCalledWith("Gossiping");

    // Redis keys should still be set despite the seeding failure
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Gossiping");
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    expect(pipe.exec).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeSubscriptionFromRedis
// ---------------------------------------------------------------------------
describe("removeSubscriptionFromRedis", () => {
  it("should only remove the keyword when user has remaining keywords on the board", async () => {
    // scard returns > 0 → user still has other keywords
    mockRedis.scard.mockResolvedValue(2);

    await removeSubscriptionFromRedis("u1", "Gossiping", "covid");

    // Should remove keyword from user board set
    expect(mockRedis.srem).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    // Should check remaining keywords
    expect(mockRedis.scard).toHaveBeenCalledWith("user:u1:board:Gossiping");

    // Should NOT remove user from board subs or board from boards
    expect(mockRedis.srem).toHaveBeenCalledTimes(1);
    // Should NOT clean board:latest
    expect(removeLatestTimestamp).not.toHaveBeenCalled();
  });

  it("should also remove user from board subs when no keywords remain", async () => {
    // First scard (user keywords) → 0, second scard (board subs) → 1
    mockRedis.scard
      .mockResolvedValueOnce(0) // remaining user keywords
      .mockResolvedValueOnce(1); // board still has other subscribers

    await removeSubscriptionFromRedis("u1", "Gossiping", "covid");

    // Should remove keyword
    expect(mockRedis.srem).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    // Should remove user from board subscriber set
    expect(mockRedis.srem).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");

    // Should NOT remove board from boards set (other subscribers remain)
    expect(mockRedis.srem).not.toHaveBeenCalledWith("boards", "Gossiping");
    expect(removeLatestTimestamp).not.toHaveBeenCalled();
  });

  it("should remove board from boards set and clean board:latest when no subscribers remain", async () => {
    // Both scard calls return 0
    mockRedis.scard
      .mockResolvedValueOnce(0) // remaining user keywords
      .mockResolvedValueOnce(0); // no other board subscribers

    await removeSubscriptionFromRedis("u1", "Gossiping", "covid");

    // Full cleanup chain
    expect(mockRedis.srem).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    expect(mockRedis.srem).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");
    expect(mockRedis.srem).toHaveBeenCalledWith("boards", "Gossiping");
    // Should also clean board:latest HASH
    expect(removeLatestTimestamp).toHaveBeenCalledWith("Gossiping");
  });
});
