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

jest.mock("../../user/services/errorLogger", () => ({
  logError: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("./pttClient", () => ({
  PTT_BASE_URL: "https://www.ptt.cc",
  pttClient: { get: jest.fn() },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { logError } from "../../user/services/errorLogger";
import { extractCode, extractTimestamp, fetchHtml, parsePushCount } from "./htmlFetcher";
import { pttClient } from "./pttClient";

const mockGet = pttClient.get as jest.Mock;
const mockLogError = logError as jest.Mock;

// ── HTML Fixtures ────────────────────────────────────────────────────────────

/** Minimal board page with one normal article and one pinned article. */
const HTML_NORMAL = `
<div class="r-ent">
  <div class="nrec"><span>10</span></div>
  <div class="title"><a href="/bbs/Gossiping/M.1700000000.A.AB1.html">Test Title</a></div>
  <div class="meta"><div class="author">testuser</div></div>
</div>
<div class="r-list-sep"></div>
<div class="r-ent">
  <div class="nrec"><span>99</span></div>
  <div class="title"><a href="/bbs/Gossiping/M.1600000000.A.CDE.html">Pinned Post</a></div>
  <div class="meta"><div class="author">admin</div></div>
</div>`;

/** Board page with no articles. */
const HTML_EMPTY = `<div class="r-list-container"></div>`;

/** Board page with an article that has no href on the title anchor. */
const HTML_NO_HREF = `
<div class="r-ent">
  <div class="nrec"><span>5</span></div>
  <div class="title">(deleted)</div>
  <div class="meta"><div class="author">somebody</div></div>
</div>`;

/** ALLPOST board page with board name embedded in title. */
const HTML_ALLPOST = `
<div class="r-ent">
  <div class="nrec"><span>爆</span></div>
  <div class="title"><a href="/bbs/ALLPOST/M.1700000001.A.F00.html">[News] Breaking (Stock)</a></div>
  <div class="meta"><div class="author">reporter</div></div>
</div>`;

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("parsePushCount", () => {
  it("returns 0 for empty string", () => {
    expect(parsePushCount("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(parsePushCount("  ")).toBe(0);
  });

  it('returns 100 for "爆"', () => {
    expect(parsePushCount("爆")).toBe(100);
  });

  it('returns -10 for "X1"', () => {
    expect(parsePushCount("X1")).toBe(-10);
  });

  it('returns -50 for "X5"', () => {
    expect(parsePushCount("X5")).toBe(-50);
  });

  it('returns 10 for "10"', () => {
    expect(parsePushCount("10")).toBe(10);
  });

  it("returns 0 for non-numeric text", () => {
    expect(parsePushCount("abc")).toBe(0);
  });
});

describe("extractCode", () => {
  it("extracts article code from a valid PTT URL", () => {
    expect(extractCode("/bbs/Gossiping/M.1234567890.A.ABC.html")).toBe("M.1234567890.A.ABC");
  });

  it("returns null for an invalid URL", () => {
    expect(extractCode("/bbs/Gossiping/invalid.html")).toBeNull();
  });
});

describe("extractTimestamp", () => {
  it("extracts timestamp as BigInt from article code", () => {
    expect(extractTimestamp("M.1234567890.A.ABC")).toBe(BigInt(1234567890));
  });
});

describe("fetchHtml", () => {
  it("parses normal HTML and returns RawArticle[]", async () => {
    mockGet.mockResolvedValueOnce({ data: HTML_NORMAL });

    const result = await fetchHtml("Gossiping");

    expect(mockGet).toHaveBeenCalledWith("https://www.ptt.cc/bbs/Gossiping/index.html");
    expect(result).toHaveLength(1);

    const article: RawArticle = result[0];
    expect(article).toEqual({
      code: "M.1700000000.A.AB1",
      timestamp: BigInt(1700000000),
      title: "Test Title",
      link: "https://www.ptt.cc/bbs/Gossiping/M.1700000000.A.AB1.html",
      author: "testuser",
      board: "Gossiping",
      pushSum: 10,
    });
  });

  it("skips pinned articles after .r-list-sep", async () => {
    mockGet.mockResolvedValueOnce({ data: HTML_NORMAL });

    const result = await fetchHtml("Gossiping");

    // Only the non-pinned article should be returned
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Test Title");
  });

  it("returns empty array when no .r-ent elements exist", async () => {
    mockGet.mockResolvedValueOnce({ data: HTML_EMPTY });

    const result = await fetchHtml("Gossiping");

    expect(result).toEqual([]);
  });

  it("throws and calls logError on HTTP error", async () => {
    const httpError = Object.assign(new Error("Request failed"), {
      response: { status: 404 },
    });
    mockGet.mockRejectedValueOnce(httpError);

    await expect(fetchHtml("Gossiping")).rejects.toThrow("Request failed");

    expect(mockLogError).toHaveBeenCalledWith(
      "ERROR",
      "CRAWLER",
      "HTML fetch failed: Gossiping",
      expect.objectContaining({
        board: "Gossiping",
        httpStatus: 404,
        errorMsg: "Request failed",
      }),
    );
  });

  it("extracts real board name from title on ALLPOST board", async () => {
    mockGet.mockResolvedValueOnce({ data: HTML_ALLPOST });

    const result = await fetchHtml("ALLPOST");

    expect(result).toHaveLength(1);
    expect(result[0].board).toBe("Stock");
    expect(result[0].link).toBe("https://www.ptt.cc/bbs/Stock/M.1700000001.A.F00.html");
  });

  it("skips articles without href on the title anchor", async () => {
    mockGet.mockResolvedValueOnce({ data: HTML_NO_HREF });

    const result = await fetchHtml("Gossiping");

    expect(result).toEqual([]);
  });
});
