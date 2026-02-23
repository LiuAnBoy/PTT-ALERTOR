import type { RawArticle } from "../types/article";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../../../core/queue", () => ({
  bullmqConnection: { host: "localhost", port: 6379 },
}));

// Mock BullMQ Queue
const mockAdd = jest.fn().mockResolvedValue({});
const mockAddBulk = jest.fn().mockResolvedValue([]);
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockAdd, addBulk: mockAddBulk })),
}));

jest.mock("./htmlFetcher", () => ({ fetchHtml: jest.fn() }));
jest.mock("./articleCache", () => ({
  filterNewArticles: jest.fn(),
  cacheArticles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./detailFetcher", () => ({
  ARTICLE_DELETED: Symbol("ARTICLE_DELETED"),
  fetchDetail: jest.fn(),
}));
jest.mock("../repositories/articleRepository", () => ({
  insertNewArticles: jest.fn().mockResolvedValue(1),
  getActiveArticles: jest.fn(),
  expireArticle: jest.fn().mockResolvedValue(undefined),
  updateArticleDetail: jest.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  expireArticle,
  getActiveArticles,
  insertNewArticles,
  updateArticleDetail,
} from "../repositories/articleRepository";
import { cacheArticles, filterNewArticles } from "./articleCache";
import { fetchNewArticles, updateActiveArticles } from "./crawlerService";
import { ARTICLE_DELETED, fetchDetail } from "./detailFetcher";
import { fetchHtml } from "./htmlFetcher";

const mockFetchHtml = fetchHtml as jest.Mock;
const mockFilterNewArticles = filterNewArticles as jest.Mock;
const mockCacheArticles = cacheArticles as jest.Mock;
const mockFetchDetail = fetchDetail as jest.Mock;
const mockInsertNewArticles = insertNewArticles as jest.Mock;
const mockGetActiveArticles = getActiveArticles as jest.Mock;
const mockExpireArticle = expireArticle as jest.Mock;
const mockUpdateArticleDetail = updateArticleDetail as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a RawArticle fixture with sensible defaults.
 * @param code - Unique article code.
 * @param board - Board name, defaults to "Gossiping".
 */
function makeArticle(code: string, board = "Gossiping"): RawArticle {
  return {
    code,
    timestamp: BigInt(1234567890),
    title: `[問卦] test ${code}`,
    link: `https://www.ptt.cc/bbs/${board}/${code}.html`,
    author: "testuser",
    board,
    pushSum: 10,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ---- fetchNewArticles -------------------------------------------------------

describe("fetchNewArticles", () => {
  it("should return empty array when fetchHtml returns no articles", async () => {
    mockFetchHtml.mockResolvedValueOnce([]);

    const result = await fetchNewArticles("Gossiping");

    expect(result).toEqual([]);
    expect(mockFilterNewArticles).not.toHaveBeenCalled();
    expect(mockInsertNewArticles).not.toHaveBeenCalled();
  });

  it("should return empty array when all articles are already cached", async () => {
    const articles = [makeArticle("M.001"), makeArticle("M.002")];
    mockFetchHtml.mockResolvedValueOnce(articles);
    mockFilterNewArticles.mockResolvedValueOnce([]);

    const result = await fetchNewArticles("Gossiping");

    expect(result).toEqual([]);
    expect(mockFilterNewArticles).toHaveBeenCalledWith("Gossiping", articles);
    expect(mockInsertNewArticles).not.toHaveBeenCalled();
    expect(mockCacheArticles).not.toHaveBeenCalled();
  });

  it("should insert, cache, fetch details, and enqueue matcher jobs for new articles", async () => {
    const allArticles = [makeArticle("M.001"), makeArticle("M.002"), makeArticle("M.003")];
    const newArticles = [makeArticle("M.002"), makeArticle("M.003")];

    mockFetchHtml.mockResolvedValueOnce(allArticles);
    mockFilterNewArticles.mockResolvedValueOnce(newArticles);
    // fetchDetail is called for each new article in fetchDetailsForArticles
    mockFetchDetail.mockResolvedValue({
      ip: "1.2.3.4",
      content: "body",
      positive: 1,
      negative: 0,
      neutral: 0,
      comments: [],
    });
    mockUpdateArticleDetail.mockResolvedValue(true);

    const result = await fetchNewArticles("Gossiping");

    expect(result).toEqual(newArticles);
    expect(mockInsertNewArticles).toHaveBeenCalledWith(newArticles);
    expect(mockCacheArticles).toHaveBeenCalledWith("Gossiping", newArticles);
    // fetchDetail called once per new article for detail fetching
    expect(mockFetchDetail).toHaveBeenCalledTimes(2);
    expect(mockFetchDetail).toHaveBeenCalledWith(newArticles[0].link);
    expect(mockFetchDetail).toHaveBeenCalledWith(newArticles[1].link);
    // matcherQueue.addBulk called once with all new articles
    expect(mockAddBulk).toHaveBeenCalledTimes(1);
  });

  it("should call matcherQueue.addBulk with correct payload for new articles", async () => {
    const newArticles = [makeArticle("M.010", "Stock"), makeArticle("M.011", "Stock")];

    mockFetchHtml.mockResolvedValueOnce(newArticles);
    mockFilterNewArticles.mockResolvedValueOnce(newArticles);
    mockFetchDetail.mockResolvedValue(null);
    mockUpdateArticleDetail.mockResolvedValue(false);

    await fetchNewArticles("Stock");

    expect(mockAddBulk).toHaveBeenCalledTimes(1);
    expect(mockAddBulk).toHaveBeenCalledWith([
      {
        name: "match",
        data: {
          board: "Stock",
          title: newArticles[0].title,
          code: "M.010",
          author: "testuser",
          pushSum: 10,
          link: newArticles[0].link,
        },
      },
      {
        name: "match",
        data: {
          board: "Stock",
          title: newArticles[1].title,
          code: "M.011",
          author: "testuser",
          pushSum: 10,
          link: newArticles[1].link,
        },
      },
    ]);
  });
});

// ---- updateActiveArticles ---------------------------------------------------

describe("updateActiveArticles", () => {
  it("should return 0 when there are no active articles", async () => {
    mockGetActiveArticles.mockResolvedValueOnce([]);

    const result = await updateActiveArticles();

    expect(result).toBe(0);
    expect(mockFetchDetail).not.toHaveBeenCalled();
  });

  it("should call updateArticleDetail and return count of changed articles", async () => {
    const articles = [makeArticle("M.100"), makeArticle("M.101")];
    mockGetActiveArticles.mockResolvedValueOnce(articles);

    const detail = {
      ip: "5.6.7.8",
      content: "updated",
      positive: 5,
      negative: 1,
      neutral: 2,
      comments: [],
    };
    mockFetchDetail.mockResolvedValue(detail);
    // First article changed, second not changed
    mockUpdateArticleDetail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await updateActiveArticles();

    expect(result).toBe(1);
    expect(mockUpdateArticleDetail).toHaveBeenCalledTimes(2);
    expect(mockUpdateArticleDetail).toHaveBeenCalledWith("M.100", detail);
    expect(mockUpdateArticleDetail).toHaveBeenCalledWith("M.101", detail);
  });

  it("should call expireArticle when fetchDetail returns ARTICLE_DELETED", async () => {
    const articles = [makeArticle("M.200"), makeArticle("M.201")];
    mockGetActiveArticles.mockResolvedValueOnce(articles);

    // First article deleted, second has valid detail
    mockFetchDetail.mockResolvedValueOnce(ARTICLE_DELETED).mockResolvedValueOnce({
      ip: null,
      content: "ok",
      positive: 0,
      negative: 0,
      neutral: 0,
      comments: [],
    });
    mockUpdateArticleDetail.mockResolvedValueOnce(true);

    const result = await updateActiveArticles();

    expect(mockExpireArticle).toHaveBeenCalledTimes(1);
    expect(mockExpireArticle).toHaveBeenCalledWith("M.200");
    // Only the second article was updated
    expect(mockUpdateArticleDetail).toHaveBeenCalledTimes(1);
    expect(result).toBe(1);
  });

  it("should skip article when fetchDetail returns null", async () => {
    const articles = [makeArticle("M.300"), makeArticle("M.301")];
    mockGetActiveArticles.mockResolvedValueOnce(articles);

    // First returns null, second returns valid detail
    mockFetchDetail.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ip: "9.9.9.9",
      content: "content",
      positive: 1,
      negative: 0,
      neutral: 0,
      comments: [],
    });
    mockUpdateArticleDetail.mockResolvedValueOnce(true);

    const result = await updateActiveArticles();

    expect(result).toBe(1);
    // updateArticleDetail should only be called for the second article
    expect(mockUpdateArticleDetail).toHaveBeenCalledTimes(1);
    expect(mockUpdateArticleDetail).toHaveBeenCalledWith(
      "M.301",
      expect.objectContaining({ ip: "9.9.9.9" }),
    );
    // expireArticle should not be called (null is not ARTICLE_DELETED)
    expect(mockExpireArticle).not.toHaveBeenCalled();
  });
});
