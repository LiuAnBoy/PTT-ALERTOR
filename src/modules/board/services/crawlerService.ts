import { Queue } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import {
  expireArticle,
  getActiveArticles,
  insertNewArticles,
  updateArticleDetail,
} from "../repositories/articleRepository";
import type { RawArticle } from "../types/article";
import { cacheArticles, filterNewArticles } from "./articleCache";
import { ARTICLE_DELETED, fetchDetail } from "./detailFetcher";
import { fetchHtml } from "./htmlFetcher";

const logger = createLogger("CRAWLER");

const matcherQueue = new Queue("matcher-queue", { connection: bullmqConnection });

/**
 * Fetch new articles from a board via HTML scraping.
 * Inserts new articles to DB, updates Redis cache, and fetches detail pages.
 *
 * @param boardName - The board name to crawl.
 * @returns Array of new articles found.
 */
export async function fetchNewArticles(boardName: string): Promise<RawArticle[]> {
  const articles = await fetchHtml(boardName);

  if (articles.length === 0) {
    logger.debug(`No articles found for ${boardName}`);
    return [];
  }

  // Filter new articles via Redis ZSET
  const newArticles = await filterNewArticles(boardName, articles);

  if (newArticles.length === 0) {
    logger.debug(`No new articles for ${boardName}`);
    return [];
  }

  // Insert new articles only (skip existing)
  const count = await insertNewArticles(newArticles);
  logger.info(`${boardName}: ${count} new articles saved`);

  // Update Redis cache
  await cacheArticles(boardName, newArticles);

  // Fetch detail pages for new articles
  await fetchDetailsForArticles(newArticles);

  // Dispatch matcher jobs for new articles
  for (const article of newArticles) {
    await matcherQueue.add("match", {
      board: article.board,
      title: article.title,
      code: article.code,
      author: article.author,
      pushSum: article.pushSum,
      link: article.link,
    });
  }

  return newArticles;
}

/**
 * Update detail data for all active articles (within expiry window).
 * Skips articles where push counts and content have not changed.
 *
 * @returns Number of articles updated.
 */
export async function updateActiveArticles(): Promise<number> {
  const articles = await getActiveArticles();

  if (articles.length === 0) {
    logger.debug("No active articles to update");
    return 0;
  }

  let updated = 0;

  let expired = 0;

  for (const article of articles) {
    const detail = await fetchDetail(article.link);

    if (detail === ARTICLE_DELETED) {
      await expireArticle(article.code);
      expired++;
      continue;
    }

    if (!detail) continue;

    const changed = await updateArticleDetail(article.code, detail);
    if (changed) updated++;
  }

  if (expired > 0) {
    logger.info(`Expired ${expired} deleted articles`);
  }
  if (updated > 0) {
    logger.info(`Updated ${updated}/${articles.length} active articles`);
  } else {
    logger.debug(`No changes in ${articles.length} active articles`);
  }

  return updated;
}

/**
 * Fetch detail pages for a batch of articles.
 * @param articles - Articles to fetch details for.
 */
async function fetchDetailsForArticles(articles: RawArticle[]): Promise<void> {
  let fetched = 0;

  for (const article of articles) {
    const detail = await fetchDetail(article.link);

    if (detail === ARTICLE_DELETED) {
      await expireArticle(article.code);
      continue;
    }

    if (!detail) continue;

    await updateArticleDetail(article.code, detail);
    fetched++;
  }

  logger.info(`Fetched details for ${fetched}/${articles.length} articles`);
}
