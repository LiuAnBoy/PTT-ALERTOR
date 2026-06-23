import type { ArticleDetail } from "../types/article";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

jest.mock("../services/pttClient", () => ({
  pttClient: { get: jest.fn() },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { logError } from "../../user/services/errorLogger";
import { ARTICLE_DELETED, extractIp, fetchDetail } from "../services/detailFetcher";
import { pttClient } from "../services/pttClient";

const mockGet = pttClient.get as jest.Mock;
const mockLogError = logError as jest.Mock;

// ── HTML fixtures ────────────────────────────────────────────────────────────

/**
 * Build a minimal PTT article page HTML string.
 * @param opts - Options to customise the fixture.
 */
function buildHtml(
  opts: {
    bodyText?: string;
    ip?: string;
    footer?: boolean;
    comments?: Array<{ tag: string; userId: string; content: string; dateTime: string }>;
  } = {},
): string {
  const {
    bodyText = "This is the article body.",
    ip = "1.2.3.4",
    footer = true,
    comments = [],
  } = opts;

  const metaline = `<div class="article-metaline"><span>Author</span></div>`;
  const metalineRight = `<div class="article-metaline-right"><span>Board</span></div>`;

  const pushHtml = comments
    .map(
      (c) =>
        `<div class="push">` +
        `<span class="push-tag">${c.tag}</span>` +
        `<span class="push-userid">${c.userId}</span>` +
        `<span class="push-content">: ${c.content}</span>` +
        `<span class="push-ipdatetime">${c.dateTime}</span>` +
        `</div>`,
    )
    .join("\n");

  const ipLine = ip ? `\n※ 發信站: 批踢踢實業坊(ptt.cc), 來自: ${ip} (Taiwan)` : "";
  const footerLine = footer ? `\n※ 發信站: 批踢踢實業坊(ptt.cc)` : "";

  return (
    `<html><body>` +
    `<div id="main-content">` +
    `${metaline}${metalineRight}` +
    `${bodyText}` +
    `${ipLine}` +
    `${footerLine}` +
    `${pushHtml}` +
    `</div>` +
    `</body></html>`
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ---- Pure function: extractIp -------------------------------------------

describe("extractIp", () => {
  it("should extract IP from standard PTT footer text", () => {
    expect(extractIp("來自: 1.2.3.4")).toBe("1.2.3.4");
  });

  it("should extract IP when extra text follows the address", () => {
    expect(extractIp("來自: 192.168.1.1 (some text)")).toBe("192.168.1.1");
  });

  it("should return null when text contains no IP pattern", () => {
    expect(extractIp("no ip here")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(extractIp("")).toBeNull();
  });
});

// ---- Async function: fetchDetail ----------------------------------------

describe("fetchDetail", () => {
  const TEST_LINK = "/bbs/Gossiping/M.1700000000.A.001.html";

  it("should parse a normal article with comments and return correct counts", async () => {
    const html = buildHtml({
      bodyText: "Hello PTT world!",
      ip: "10.0.0.1",
      footer: true,
      comments: [
        { tag: "推", userId: "user1", content: "nice", dateTime: "01/01 12:00" },
        { tag: "噓", userId: "user2", content: "bad", dateTime: "01/01 12:01" },
        { tag: "→", userId: "user3", content: "hmm", dateTime: "01/01 12:02" },
        { tag: "推", userId: "user4", content: "good", dateTime: "01/01 12:03" },
      ],
    });

    mockGet.mockResolvedValueOnce({ data: html });

    const result = (await fetchDetail(TEST_LINK)) as ArticleDetail;

    expect(result).not.toBeNull();
    expect(result).not.toBe(ARTICLE_DELETED);
    expect(result.ip).toBe("10.0.0.1");
    expect(result.positive).toBe(2);
    expect(result.negative).toBe(1);
    expect(result.neutral).toBe(1);
    expect(result.comments).toHaveLength(4);
    expect(result.comments[0]).toEqual({
      tag: "推",
      userId: "user1",
      content: "nice",
      dateTime: "01/01 12:00",
    });
    // Content should not contain footer
    expect(result.content).not.toContain("※ 發信站:");
    // Content should include the article body
    expect(result.content).toContain("Hello PTT world!");
  });

  it("should return zero counts when article has no comments", async () => {
    const html = buildHtml({
      bodyText: "A quiet article.",
      ip: "172.16.0.1",
      footer: true,
      comments: [],
    });

    mockGet.mockResolvedValueOnce({ data: html });

    const result = (await fetchDetail(TEST_LINK)) as ArticleDetail;

    expect(result.positive).toBe(0);
    expect(result.negative).toBe(0);
    expect(result.neutral).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.ip).toBe("172.16.0.1");
  });

  it("should strip content after the footer signature line", async () => {
    const html = buildHtml({
      bodyText: "Important content here.",
      ip: "5.6.7.8",
      footer: true,
      comments: [],
    });

    mockGet.mockResolvedValueOnce({ data: html });

    const result = (await fetchDetail(TEST_LINK)) as ArticleDetail;

    expect(result.content).toContain("Important content here.");
    expect(result.content).not.toContain("※ 發信站:");
  });

  it("should return ARTICLE_DELETED symbol on HTTP 404", async () => {
    const error404 = Object.assign(new Error("Request failed with status code 404"), {
      response: { status: 404 },
    });
    mockGet.mockRejectedValueOnce(error404);

    const result = await fetchDetail(TEST_LINK);

    expect(result).toBe(ARTICLE_DELETED);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("should return null and call logError on HTTP 500", async () => {
    const error500 = Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500 },
    });
    mockGet.mockRejectedValueOnce(error500);

    const result = await fetchDetail(TEST_LINK);

    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "ERROR",
      "CRAWLER",
      expect.stringContaining("Detail fetch failed"),
      expect.objectContaining({ url: TEST_LINK, httpStatus: 500 }),
    );
  });

  it("should classify a parse failure with kind:'parse' (not as a network error)", async () => {
    // Resolve with a non-string body so cheerio.load throws → parse branch.
    mockGet.mockResolvedValueOnce({ data: 42 });

    const result = await fetchDetail(TEST_LINK);

    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "ERROR",
      "CRAWLER",
      expect.stringContaining("Detail parse failed"),
      expect.objectContaining({ url: TEST_LINK, kind: "parse" }),
    );
  });

  it("should return null and call logError on network error (no response)", async () => {
    const networkError = new Error("ECONNREFUSED");
    mockGet.mockRejectedValueOnce(networkError);

    const result = await fetchDetail(TEST_LINK);

    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "ERROR",
      "CRAWLER",
      expect.stringContaining("Detail fetch failed"),
      expect.objectContaining({
        url: TEST_LINK,
        errorMsg: "ECONNREFUSED",
      }),
    );
  });
});
