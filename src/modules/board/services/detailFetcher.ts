import * as cheerio from "cheerio";

import { createLogger } from "../../../core/logger";
import { logError } from "../../user/services/errorLogger";
import type { ArticleComment, ArticleDetail } from "../types/article";
import { pttClient } from "./pttClient";

const logger = createLogger("CRAWLER");

const IP_REGEX = /來自: ([\d.]+)/;

/**
 * Extract author IP from the article footer.
 * @param text - The raw text of #main-content.
 * @returns The IP address or null.
 */
/**
 * @internal Exported for unit testing only.
 */
export function extractIp(text: string): string | null {
  const match = text.match(IP_REGEX);
  return match ? match[1] : null;
}

/** Sentinel value indicating the article was deleted (HTTP 404). */
export const ARTICLE_DELETED = Symbol("ARTICLE_DELETED");

/**
 * Fetch and parse an article detail page.
 * @param link - Full URL of the article.
 * @returns Parsed article detail, ARTICLE_DELETED if 404, or null on transient failure.
 */
export async function fetchDetail(
  link: string,
): Promise<ArticleDetail | typeof ARTICLE_DELETED | null> {
  let data: string;
  try {
    ({ data } = await pttClient.get<string>(link));
  } catch (error) {
    const status = (error as { response?: { status: number } }).response?.status;

    if (status === 404) {
      logger.info(`Article deleted (404): ${link}`);
      return ARTICLE_DELETED;
    }

    logger.warn(`Failed to fetch detail: ${link}`);
    await logError("ERROR", "CRAWLER", `Detail fetch failed: ${link}`, {
      url: link,
      httpStatus: status,
      errorMsg: (error as Error).message,
    });
    return null;
  }

  try {
    const $ = cheerio.load(data);

    // Extract IP before removing elements
    const rawText = $("#main-content").text();
    const ip = extractIp(rawText);

    // Parse comments
    const comments: ArticleComment[] = [];
    let positive = 0;
    let negative = 0;
    let neutral = 0;

    $(".push").each((_i, el) => {
      const $el = $(el);
      const tag = $el.find(".push-tag").text().trim();
      const userId = $el.find(".push-userid").text().trim();
      const content = $el.find(".push-content").text().replace(/^:\s*/, "").trim();
      const dateTime = $el.find(".push-ipdatetime").text().trim();

      if (tag === "推") positive++;
      else if (tag === "噓") negative++;
      else if (tag === "→") neutral++;

      comments.push({ tag, userId, content, dateTime });
    });

    // Remove non-content elements to extract article body
    $(".push").remove();
    $(".article-metaline").remove();
    $(".article-metaline-right").remove();

    // Get content and strip footer signature
    let content = $("#main-content").text().trim();
    const footerIdx = content.indexOf("※ 發信站:");
    if (footerIdx !== -1) {
      content = content.substring(0, footerIdx).trim();
    }

    return { ip, content, positive, negative, neutral, comments };
  } catch (error) {
    logger.warn(`Failed to parse detail: ${link}`);
    await logError("ERROR", "CRAWLER", `Detail parse failed: ${link}`, {
      url: link,
      kind: "parse",
      parseError: (error as Error).message,
    });
    return null;
  }
}
