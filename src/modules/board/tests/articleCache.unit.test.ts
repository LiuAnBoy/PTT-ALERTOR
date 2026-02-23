import { createMockRedis } from "../../../__mocks__/mockRedis";
import type { RawArticle } from "../types/article";

const mockRedis = createMockRedis();

jest.mock("../../../core/redis", () => ({
  redis: mockRedis,
}));
jest.mock("../../user/services/errorLogger", () => ({
  logError: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/pttClient", () => ({
  PTT_BASE_URL: "https://www.ptt.cc",
}));

import {
  addActiveArticles,
  cacheArticles,
  cleanActiveArticles,
  filterNewArticles,
  getActiveArticleCodes,
  getLatestTimestamp,
  hasLatestTimestamp,
  removeActiveArticle,
  removeLatestTimestamp,
  setLatestTimestamp,
} from "../services/articleCache";

/**
 * Create a test RawArticle with sensible defaults.
 */
function makeArticle(code: string, board = "Gossiping", timestamp = 1234567890): RawArticle {
  return {
    code,
    timestamp: BigInt(timestamp),
    title: "test",
    link: `https://www.ptt.cc/bbs/${board}/${code}.html`,
    author: "testuser",
    board,
    pushSum: 10,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── board:latest HASH operations ────────────────────────────────────────────

describe("getLatestTimestamp", () => {
  it("should return number when HGET returns a value", async () => {
    mockRedis.hget.mockResolvedValueOnce("1234567890");

    const result = await getLatestTimestamp("Gossiping");

    expect(result).toBe(1234567890);
    expect(mockRedis.hget).toHaveBeenCalledWith("board:latest", "Gossiping");
  });

  it("should return null when HGET returns null", async () => {
    mockRedis.hget.mockResolvedValueOnce(null);

    const result = await getLatestTimestamp("Gossiping");

    expect(result).toBeNull();
  });
});

describe("setLatestTimestamp", () => {
  it("should call HSET with board and timestamp", async () => {
    await setLatestTimestamp("Gossiping", 1234567890);

    expect(mockRedis.hset).toHaveBeenCalledWith("board:latest", "Gossiping", 1234567890);
  });
});

describe("removeLatestTimestamp", () => {
  it("should call HDEL with board", async () => {
    await removeLatestTimestamp("Gossiping");

    expect(mockRedis.hdel).toHaveBeenCalledWith("board:latest", "Gossiping");
  });
});

describe("hasLatestTimestamp", () => {
  it("should return true when HEXISTS returns 1", async () => {
    mockRedis.hexists.mockResolvedValueOnce(1);

    const result = await hasLatestTimestamp("Gossiping");

    expect(result).toBe(true);
  });

  it("should return false when HEXISTS returns 0", async () => {
    mockRedis.hexists.mockResolvedValueOnce(0);

    const result = await hasLatestTimestamp("Gossiping");

    expect(result).toBe(false);
  });
});

// ── active:articles ZSET operations ─────────────────────────────────────────

describe("addActiveArticles", () => {
  it("should ZADD each article to active:articles ZSET", async () => {
    const articles = [
      { board: "Gossiping", code: "M.001", timestamp: 100 },
      { board: "Stock", code: "M.002", timestamp: 200 },
    ];

    mockRedis._mockPipeline.exec.mockResolvedValueOnce([]);

    await addActiveArticles(articles);

    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledWith(
      "active:articles",
      100,
      "Gossiping:M.001",
    );
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledWith(
      "active:articles",
      200,
      "Stock:M.002",
    );
  });

  it("should skip pipeline when array is empty", async () => {
    await addActiveArticles([]);

    expect(mockRedis.pipeline).not.toHaveBeenCalled();
  });
});

describe("removeActiveArticle", () => {
  it("should ZREM the article from active:articles", async () => {
    await removeActiveArticle("Gossiping", "M.001");

    expect(mockRedis.zrem).toHaveBeenCalledWith("active:articles", "Gossiping:M.001");
  });
});

describe("getActiveArticleCodes", () => {
  it("should return parsed articles from ZRANGEBYSCORE", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce([
      "Gossiping:M.001",
      "Gossiping:M.002",
      "Stock:M.100",
    ]);

    const result = await getActiveArticleCodes();

    expect(result).toEqual([
      { code: "M.001", board: "Gossiping", link: "https://www.ptt.cc/bbs/Gossiping/M.001.html" },
      { code: "M.002", board: "Gossiping", link: "https://www.ptt.cc/bbs/Gossiping/M.002.html" },
      { code: "M.100", board: "Stock", link: "https://www.ptt.cc/bbs/Stock/M.100.html" },
    ]);
  });

  it("should return empty array when ZRANGEBYSCORE returns empty", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce([]);

    const result = await getActiveArticleCodes();

    expect(result).toEqual([]);
  });

  it("should return empty array when ZRANGEBYSCORE returns null", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce(null);

    const result = await getActiveArticleCodes();

    expect(result).toEqual([]);
  });
});

describe("cleanActiveArticles", () => {
  it("should call ZREMRANGEBYSCORE with correct params", async () => {
    mockRedis.zremrangebyscore.mockResolvedValueOnce(5);

    const result = await cleanActiveArticles(1000000);

    expect(result).toBe(5);
    expect(mockRedis.zremrangebyscore).toHaveBeenCalledWith("active:articles", "-inf", 1000000);
  });
});

// ── filterNewArticles ───────────────────────────────────────────────────────

describe("filterNewArticles", () => {
  it("should return all articles when board has no latest timestamp", async () => {
    mockRedis.hget.mockResolvedValueOnce(null);

    const articles = [
      makeArticle("M.001", "Gossiping", 100),
      makeArticle("M.002", "Gossiping", 200),
    ];
    const result = await filterNewArticles("Gossiping", articles);

    expect(result).toEqual(articles);
  });

  it("should return only articles newer than latest timestamp", async () => {
    mockRedis.hget.mockResolvedValueOnce("150");

    const articles = [
      makeArticle("M.001", "Gossiping", 100),
      makeArticle("M.002", "Gossiping", 150),
      makeArticle("M.003", "Gossiping", 200),
    ];
    const result = await filterNewArticles("Gossiping", articles);

    expect(result).toEqual([articles[2]]);
  });

  it("should return empty array when input is empty", async () => {
    const result = await filterNewArticles("Gossiping", []);

    expect(result).toEqual([]);
    expect(mockRedis.hget).not.toHaveBeenCalled();
  });

  it("should return empty when all articles are older than latest", async () => {
    mockRedis.hget.mockResolvedValueOnce("300");

    const articles = [
      makeArticle("M.001", "Gossiping", 100),
      makeArticle("M.002", "Gossiping", 200),
    ];
    const result = await filterNewArticles("Gossiping", articles);

    expect(result).toEqual([]);
  });
});

// ── cacheArticles ───────────────────────────────────────────────────────────

describe("cacheArticles", () => {
  it("should ZADD to active:articles and HSET board:latest with max timestamp", async () => {
    const articles = [
      makeArticle("M.001", "Gossiping", 100),
      makeArticle("M.002", "Gossiping", 300),
      makeArticle("M.003", "Gossiping", 200),
    ];

    mockRedis._mockPipeline.exec.mockResolvedValueOnce([]);

    await cacheArticles("Gossiping", articles);

    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledTimes(3);
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledWith(
      "active:articles",
      100,
      "Gossiping:M.001",
    );
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledWith(
      "active:articles",
      300,
      "Gossiping:M.002",
    );
    // HSET with max timestamp (300)
    expect(mockRedis._mockPipeline.hset).toHaveBeenCalledWith("board:latest", "Gossiping", 300);
  });

  it("should skip pipeline when array is empty", async () => {
    await cacheArticles("Gossiping", []);

    expect(mockRedis.pipeline).not.toHaveBeenCalled();
  });
});
