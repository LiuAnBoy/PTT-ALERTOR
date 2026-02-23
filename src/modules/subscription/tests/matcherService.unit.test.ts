import { createMockRedis } from "../../../__mocks__/mockRedis";

const mockRedis = createMockRedis();

jest.mock("../../../core/redis", () => ({
  redis: mockRedis,
}));
jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock("../../user/services/errorLogger", () => ({
  logError: jest.fn().mockResolvedValue(undefined),
}));

import { logError } from "../../user/services/errorLogger";
import { matchArticle, matchKeyword } from "../services/matcherService";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("matchKeyword", () => {
  // Case 1: plain text case-insensitive match
  it("should match plain text case-insensitively", () => {
    expect(matchKeyword("[問卦] 今天天氣好嗎", "問卦", "user1")).toBe(true);
    expect(matchKeyword("Re: [爆卦] Something", "爆卦", "user1")).toBe(true);
    expect(matchKeyword("HELLO World", "hello", "user1")).toBe(true);
  });

  // Case 2: plain text no match
  it("should return false when plain text does not match", () => {
    expect(matchKeyword("[問卦] 今天天氣好嗎", "爆卦", "user1")).toBe(false);
    expect(matchKeyword("Hello World", "goodbye", "user1")).toBe(false);
  });

  // Case 3: regexp prefix with valid pattern matches
  it("should match with a valid regexp: prefix pattern", () => {
    expect(matchKeyword("[問卦] 為什麼貓咪這麼可愛", "regexp:問卦.*貓", "user1")).toBe(true);
    expect(matchKeyword("Re: [爆卦] 重大消息", "regexp:^Re:", "user1")).toBe(true);
  });

  // Case 4: regexp prefix with no match
  it("should return false when regexp: pattern does not match", () => {
    expect(matchKeyword("[問卦] 今天天氣好嗎", "regexp:^\\[爆卦\\]", "user1")).toBe(false);
    expect(matchKeyword("Hello World", "regexp:^Goodbye", "user1")).toBe(false);
  });

  // Case 5: regexp with invalid regex returns false and calls logError
  it("should return false and call logError for invalid regex", () => {
    const result = matchKeyword("test title", "regexp:[invalid", "user42");

    expect(result).toBe(false);
    expect(logError).toHaveBeenCalledWith("WARN", "MATCHER", "Regex compile failed: [invalid", {
      keyword: "regexp:[invalid",
      userId: "user42",
      errorMsg: "Invalid regex: [invalid",
    });
  });
});

describe("matchArticle", () => {
  /**
   * Helper to set up pipeline mock for matchArticle.
   * smembers (top-level) returns subscriber userIds for the board.
   * pipeline.exec returns keyword arrays for each user.
   */
  function setupPipelineMock(subscribers: string[], keywordsByUser: Record<string, string[]>) {
    mockRedis.smembers.mockResolvedValue(subscribers);
    const pipelineResults = subscribers.map((userId) => {
      const keywords = keywordsByUser[userId] ?? [];
      return [null, keywords];
    });
    mockRedis._mockPipeline.exec.mockResolvedValue(pipelineResults);
  }

  // Case 6: board has subscribers with matching keywords
  it("should return matched userId+keyword pairs", async () => {
    setupPipelineMock(["user1"], { user1: ["問卦"] });

    const results = await matchArticle("Gossiping", "[問卦] 今天天氣好嗎");

    expect(results).toEqual([{ userId: "user1", keyword: "問卦" }]);
  });

  // Case 7: no subscribers returns empty array
  it("should return empty array when no subscribers exist", async () => {
    mockRedis.smembers.mockResolvedValue([]);

    const results = await matchArticle("Gossiping", "[問卦] 今天天氣好嗎");

    expect(results).toEqual([]);
  });

  // Case 8: subscribers but no matching keywords
  it("should return empty array when no keywords match", async () => {
    setupPipelineMock(["user1"], { user1: ["爆卦"] });

    const results = await matchArticle("Gossiping", "[問卦] 今天天氣好嗎");

    expect(results).toEqual([]);
  });

  // Case 9: multiple users, multiple keywords, cross-matching
  it("should return correct results for multiple users and keywords", async () => {
    setupPipelineMock(["user1", "user2"], {
      user1: ["問卦", "天氣"],
      user2: ["問卦", "爆卦"],
    });

    const results = await matchArticle("Gossiping", "[問卦] 今天天氣好嗎");

    expect(results).toEqual([
      { userId: "user1", keyword: "問卦" },
      { userId: "user1", keyword: "天氣" },
      { userId: "user2", keyword: "問卦" },
    ]);
  });

  // Case 10: multiple users, only some match
  it("should return only matching pairs when some users do not match", async () => {
    setupPipelineMock(["user1", "user2", "user3"], {
      user1: ["問卦"],
      user2: ["爆卦"],
      user3: ["天氣"],
    });

    const results = await matchArticle("Gossiping", "[問卦] 今天天氣好嗎");

    expect(results).toEqual([
      { userId: "user1", keyword: "問卦" },
      { userId: "user3", keyword: "天氣" },
    ]);
  });
});
