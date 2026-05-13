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

import { matchArticle, matchKeyword } from "../services/matcherService";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("matchKeyword", () => {
  // Case 1: plain text matches via regex (case-insensitive)
  it("should match plain text case-insensitively via regex", () => {
    expect(matchKeyword("[問卦] 今天天氣好嗎", "問卦", "user1")).toBe(true);
    expect(matchKeyword("Re: [爆卦] Something", "爆卦", "user1")).toBe(true);
    expect(matchKeyword("HELLO World", "hello", "user1")).toBe(true);
  });

  // Case 2: plain text no match
  it("should return false when plain text does not match", () => {
    expect(matchKeyword("[問卦] 今天天氣好嗎", "爆卦", "user1")).toBe(false);
    expect(matchKeyword("Hello World", "goodbye", "user1")).toBe(false);
  });

  // Case 3: regex pattern matches directly (no prefix needed)
  it("should match with a regex pattern directly", () => {
    expect(matchKeyword("[問卦] 為什麼貓咪這麼可愛", "問卦.*貓", "user1")).toBe(true);
    expect(matchKeyword("Re: [爆卦] 重大消息", "^Re:", "user1")).toBe(true);
  });

  // Case 4: regex pattern no match
  it("should return false when regex pattern does not match", () => {
    expect(matchKeyword("[問卦] 今天天氣好嗎", "^\\[爆卦\\]", "user1")).toBe(false);
    expect(matchKeyword("Hello World", "^Goodbye", "user1")).toBe(false);
  });

  // Case 5: backward compatibility — legacy regexp: prefix still works
  it("should strip legacy regexp: prefix and match correctly", () => {
    expect(matchKeyword("[問卦] 為什麼貓咪這麼可愛", "regexp:問卦.*貓", "user1")).toBe(true);
    expect(matchKeyword("Re: [爆卦] 重大消息", "regexp:^Re:", "user1")).toBe(true);
    expect(matchKeyword("Hello World", "regexp:^Goodbye", "user1")).toBe(false);
  });

  // Case 6: invalid regex auto-escapes for literal matching
  it("should auto-escape invalid regex and match literally", () => {
    expect(matchKeyword("I love C++", "C++", "user1")).toBe(true);
    expect(matchKeyword("I love Java", "C++", "user1")).toBe(false);
  });

  // Case 7: AND mode (containing '&') — every sub-pattern must match
  describe("AND mode (a&b)", () => {
    it("should match when title contains all sub-patterns", () => {
      expect(matchKeyword("[PS5 ] 售 勇者鬥惡龍", "售&ps5", "user1")).toBe(true);
      expect(matchKeyword("[PS5 ] 售 PS5 SLIM", "售&ps5", "user1")).toBe(true);
    });

    it("should not match when title is missing any sub-pattern", () => {
      expect(matchKeyword("[PS5 ] 徵 羊蹄山戰鬼", "售&ps5", "user1")).toBe(false);
      expect(matchKeyword("[PS4 ] 售 FFX", "售&ps5", "user1")).toBe(false);
      expect(matchKeyword("[NS  ] 徵 瑪利歐", "售&ps5", "user1")).toBe(false);
    });

    it("should support more than two sub-patterns", () => {
      expect(matchKeyword("售 PS5 SLIM 二手", "售&ps5&二手", "user1")).toBe(true);
      expect(matchKeyword("售 PS5 SLIM 全新", "售&ps5&二手", "user1")).toBe(false);
    });

    it("should treat each sub-pattern as a regex", () => {
      // First part is regex (^\[售\]), second part is literal-ish ps5
      expect(matchKeyword("[售] PS5 主機", "^\\[售\\]&ps5", "user1")).toBe(true);
      expect(matchKeyword("PS5 [售] 主機", "^\\[售\\]&ps5", "user1")).toBe(false);
    });

    it("should ignore empty parts produced by stray &", () => {
      expect(matchKeyword("售 ps5", "售&&ps5", "user1")).toBe(true);
      expect(matchKeyword("售 ps5", "&售&ps5&", "user1")).toBe(true);
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
