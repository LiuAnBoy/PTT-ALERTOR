import { createMockRedis } from "../../../__mocks__/mockRedis";
import type { RawArticle } from "../types/article";

const mockRedis = createMockRedis();

jest.mock("../../../core/redis", () => ({
  redis: mockRedis,
}));
jest.mock("../../user/services/errorLogger", () => ({
  logError: jest.fn().mockResolvedValue(undefined),
}));

import { cacheArticles, cleanCache, filterNewArticles, isCacheEmpty } from "./articleCache";

/**
 * Create a test RawArticle with sensible defaults.
 */
function makeArticle(code: string, board = "Gossiping"): RawArticle {
  return {
    code,
    timestamp: BigInt(1234567890),
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

describe("filterNewArticles", () => {
  it("should return all articles when none are cached (zscore returns null for all)", async () => {
    const articles = [makeArticle("M.001"), makeArticle("M.002"), makeArticle("M.003")];

    // zscore returns null for every article -> all are new
    mockRedis._mockPipeline.exec.mockResolvedValueOnce(articles.map(() => [null, null]));

    const result = await filterNewArticles("Gossiping", articles);

    expect(result).toEqual(articles);
    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockRedis._mockPipeline.zscore).toHaveBeenCalledTimes(3);
    expect(mockRedis._mockPipeline.exec).toHaveBeenCalled();
  });

  it("should filter out cached articles (zscore returns a score)", async () => {
    const articles = [makeArticle("M.001"), makeArticle("M.002"), makeArticle("M.003")];

    // M.001 is new (null), M.002 is cached (score), M.003 is new (null)
    mockRedis._mockPipeline.exec.mockResolvedValueOnce([
      [null, null],
      [null, "1234567890"],
      [null, null],
    ]);

    const result = await filterNewArticles("Gossiping", articles);

    expect(result).toEqual([articles[0], articles[2]]);
  });

  it("should return empty array when input is empty", async () => {
    const result = await filterNewArticles("Gossiping", []);

    expect(result).toEqual([]);
    // Pipeline should never be created for empty input
    expect(mockRedis.pipeline).not.toHaveBeenCalled();
  });

  it("should return all articles as fallback when pipeline.exec returns null", async () => {
    const articles = [makeArticle("M.001"), makeArticle("M.002")];

    mockRedis._mockPipeline.exec.mockResolvedValueOnce(null);

    const result = await filterNewArticles("Gossiping", articles);

    expect(result).toEqual(articles);
  });
});

describe("cacheArticles", () => {
  it("should call pipeline.zadd for each article and exec the pipeline", async () => {
    const articles = [makeArticle("M.001"), makeArticle("M.002")];

    mockRedis._mockPipeline.exec.mockResolvedValueOnce([]);

    await cacheArticles("Gossiping", articles);

    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledTimes(2);
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledWith(
      "board:Gossiping:articles",
      Number(BigInt(1234567890)),
      "M.001",
    );
    expect(mockRedis._mockPipeline.zadd).toHaveBeenCalledWith(
      "board:Gossiping:articles",
      Number(BigInt(1234567890)),
      "M.002",
    );
    expect(mockRedis._mockPipeline.exec).toHaveBeenCalled();
  });

  it("should return immediately without creating a pipeline when array is empty", async () => {
    await cacheArticles("Gossiping", []);

    expect(mockRedis.pipeline).not.toHaveBeenCalled();
  });
});

describe("isCacheEmpty", () => {
  it("should return true when zcard returns 0", async () => {
    mockRedis.zcard.mockResolvedValueOnce(0);

    const result = await isCacheEmpty("Gossiping");

    expect(result).toBe(true);
    expect(mockRedis.zcard).toHaveBeenCalledWith("board:Gossiping:articles");
  });

  it("should return false when zcard returns a positive number", async () => {
    mockRedis.zcard.mockResolvedValueOnce(5);

    const result = await isCacheEmpty("Gossiping");

    expect(result).toBe(false);
    expect(mockRedis.zcard).toHaveBeenCalledWith("board:Gossiping:articles");
  });
});

describe("cleanCache", () => {
  it("should call zremrangebyscore with the correct key and params", async () => {
    mockRedis.zremrangebyscore.mockResolvedValueOnce(3);

    await cleanCache("Gossiping", 1000000000);

    expect(mockRedis.zremrangebyscore).toHaveBeenCalledWith(
      "board:Gossiping:articles",
      "-inf",
      1000000000,
    );
  });
});
