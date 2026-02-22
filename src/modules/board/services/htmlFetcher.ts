import * as cheerio from "cheerio";

import { createLogger } from "../../../core/logger";
import { logError } from "../../user/services/errorLogger";
import type { RawArticle } from "../types/article";
import { PTT_BASE_URL, pttClient } from "./pttClient";

const logger = createLogger("CRAWLER");

const PTT_BBS_URL = `${PTT_BASE_URL}/bbs`;
const CODE_REGEX = /\/([GM]\.\d+\.A\.[A-Z0-9]+)\.html/;

/**
 * Convert PTT push count text to a number.
 * @param text - The push count text (e.g. "爆", "X1", "10").
 * @returns The numeric push count.
 */
/**
 * @internal Exported for unit testing only.
 */
export function parsePushCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (trimmed === "爆") return 100;
  if (trimmed.startsWith("X")) {
    const n = parseInt(trimmed.substring(1), 10);
    return isNaN(n) ? 0 : -n * 10;
  }
  const n = parseInt(trimmed, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Extract article code from a PTT URL.
 * @param url - The article URL.
 * @returns The article code or null.
 */
/**
 * @internal Exported for unit testing only.
 */
export function extractCode(url: string): string | null {
  const match = url.match(CODE_REGEX);
  return match ? match[1] : null;
}

/**
 * Extract timestamp from article code.
 * @param code - The article code.
 * @returns The timestamp as BigInt.
 */
/**
 * @internal Exported for unit testing only.
 */
export function extractTimestamp(code: string): bigint {
  const parts = code.split(".");
  return BigInt(parts[1]);
}

/**
 * Fetch articles from a PTT board via HTML scraping.
 * @param boardName - The board name to fetch.
 * @returns Array of raw articles.
 * @throws Error on network or parsing failure.
 */
export async function fetchHtml(boardName: string): Promise<RawArticle[]> {
  const url = `${PTT_BBS_URL}/${boardName}/index.html`;
  logger.debug(`Fetching HTML: ${url}`);

  let data: string;
  try {
    const res = await pttClient.get<string>(url);
    data = res.data;
  } catch (err) {
    const httpStatus = (err as { response?: { status: number } }).response?.status;
    await logError("ERROR", "CRAWLER", `HTML fetch failed: ${boardName}`, {
      board: boardName,
      url,
      httpStatus,
      errorMsg: (err as Error).message,
    });
    throw err;
  }
  const $ = cheerio.load(data);
  const articles: RawArticle[] = [];

  // Collect pinned article elements (after .r-list-sep separator)
  const pinnedEls = new Set<cheerio.Element>();
  const sep = $(".r-list-sep").first();
  if (sep.length) {
    sep.nextAll(".r-ent").each((_i, el) => pinnedEls.add(el));
  }

  $(".r-ent").each((_i, el) => {
    // Skip pinned posts (公告, 協尋, etc.)
    if (pinnedEls.has(el)) return;

    const $el = $(el);
    const $title = $el.find(".title a");
    const title = $title.text().trim();
    const href = $title.attr("href");
    if (!href) return;

    const code = extractCode(href);
    if (!code) return;

    const link = `${PTT_BASE_URL}${href}`;
    const author = $el.find(".meta .author").text().trim() || null;
    const pushText = $el.find(".nrec span").text();
    const pushSum = parsePushCount(pushText);

    let finalBoard = boardName;
    let finalLink = link;

    // allpost board: extract real board name from title
    if (boardName.toLowerCase() === "allpost") {
      const preIdx = title.lastIndexOf("(");
      const backIdx = title.lastIndexOf(")");
      if (preIdx !== -1 && backIdx !== -1 && backIdx > preIdx) {
        finalBoard = title.substring(preIdx + 1, backIdx);
        finalLink = link.replace(/ALLPOST/i, finalBoard);
      }
    }

    articles.push({
      code,
      timestamp: extractTimestamp(code),
      title,
      link: finalLink,
      author,
      board: finalBoard,
      pushSum,
    });
  });

  logger.debug(`HTML fetched ${articles.length} articles from ${boardName}`);
  return articles;
}
