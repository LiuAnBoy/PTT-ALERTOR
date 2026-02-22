import { createMockRedis } from "../../../__mocks__/mockRedis";

const mockRedis = createMockRedis();
const mockPrisma = { subscription: { findMany: jest.fn() } };

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
  isCacheEmpty: jest.fn(),
  cacheArticles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../board/services/htmlFetcher", () => ({
  fetchHtml: jest.fn().mockResolvedValue([]),
}));

import { cacheArticles, isCacheEmpty } from "../../board/services/articleCache";
import { fetchHtml } from "../../board/services/htmlFetcher";
import {
  addSubscriptionToRedis,
  removeSubscriptionFromRedis,
  syncSubscriptions,
} from "./syncService";

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
// addSubscriptionToRedis
// ---------------------------------------------------------------------------
describe("addSubscriptionToRedis", () => {
  it("should seed cache when cache is empty, then add keys to Redis", async () => {
    const mockArticles = [{ title: "a1" }, { title: "a2" }];
    (isCacheEmpty as jest.Mock).mockResolvedValue(true);
    (fetchHtml as jest.Mock).mockResolvedValue(mockArticles);

    await addSubscriptionToRedis("u1", "Gossiping", "covid");

    // Should check cache and seed it
    expect(isCacheEmpty).toHaveBeenCalledWith("Gossiping");
    expect(fetchHtml).toHaveBeenCalledWith("Gossiping");
    expect(cacheArticles).toHaveBeenCalledWith("Gossiping", mockArticles);

    // Should still add to Redis via pipeline
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Gossiping");
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    expect(pipe.exec).toHaveBeenCalled();
  });

  it("should skip cache seeding when cache is not empty", async () => {
    (isCacheEmpty as jest.Mock).mockResolvedValue(false);

    await addSubscriptionToRedis("u1", "Stock", "TSMC");

    expect(isCacheEmpty).toHaveBeenCalledWith("Stock");
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(cacheArticles).not.toHaveBeenCalled();

    // Redis keys should still be set
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Stock");
    expect(pipe.exec).toHaveBeenCalled();
  });

  it("should warn and continue adding to Redis when fetchHtml throws", async () => {
    (isCacheEmpty as jest.Mock).mockResolvedValue(true);
    (fetchHtml as jest.Mock).mockRejectedValue(new Error("network error"));

    await addSubscriptionToRedis("u1", "Gossiping", "covid");

    // fetchHtml was called and failed
    expect(fetchHtml).toHaveBeenCalledWith("Gossiping");
    // cacheArticles should NOT have been called since fetchHtml threw
    expect(cacheArticles).not.toHaveBeenCalled();

    // Redis keys should still be set despite the seeding failure
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Gossiping");
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");
    expect(pipe.sadd).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    expect(pipe.exec).toHaveBeenCalled();
  });

  it("should use the correct Redis key patterns", async () => {
    (isCacheEmpty as jest.Mock).mockResolvedValue(false);

    await addSubscriptionToRedis("user-abc-123", "Beauty", "photo");

    // Verify exact key patterns: boards, keyword:{board}:subs, user:{id}:board:{board}
    expect(pipe.sadd).toHaveBeenCalledWith("boards", "Beauty");
    expect(pipe.sadd).toHaveBeenCalledWith("keyword:Beauty:subs", "user-abc-123");
    expect(pipe.sadd).toHaveBeenCalledWith("user:user-abc-123:board:Beauty", "photo");
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
  });

  it("should remove board from boards set when no subscribers remain", async () => {
    // Both scard calls return 0
    mockRedis.scard
      .mockResolvedValueOnce(0) // remaining user keywords
      .mockResolvedValueOnce(0); // no other board subscribers

    await removeSubscriptionFromRedis("u1", "Gossiping", "covid");

    // Full cleanup chain
    expect(mockRedis.srem).toHaveBeenCalledWith("user:u1:board:Gossiping", "covid");
    expect(mockRedis.srem).toHaveBeenCalledWith("keyword:Gossiping:subs", "u1");
    expect(mockRedis.srem).toHaveBeenCalledWith("boards", "Gossiping");
    expect(mockRedis.srem).toHaveBeenCalledTimes(3);
  });

  it("should use the correct Redis key patterns throughout removal", async () => {
    mockRedis.scard.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    await removeSubscriptionFromRedis("user-xyz-789", "Stock", "TSMC");

    // Verify key patterns: user:{id}:board:{board}, keyword:{board}:subs, boards
    expect(mockRedis.srem).toHaveBeenCalledWith("user:user-xyz-789:board:Stock", "TSMC");
    expect(mockRedis.scard).toHaveBeenCalledWith("user:user-xyz-789:board:Stock");
    expect(mockRedis.srem).toHaveBeenCalledWith("keyword:Stock:subs", "user-xyz-789");
    expect(mockRedis.scard).toHaveBeenCalledWith("keyword:Stock:subs");
    expect(mockRedis.srem).toHaveBeenCalledWith("boards", "Stock");
  });
});
