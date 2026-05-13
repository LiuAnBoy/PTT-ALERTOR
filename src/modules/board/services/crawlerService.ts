import { Queue } from "bullmq";

import { createLogger } from "../../../core/logger";
import { bullmqConnection } from "../../../core/queue";
import { insertNewArticles, updateArticleDetail } from "../repositories/articleRepository";
import type { RawArticle } from "../types/article";
import {
  cacheArticles,
  filterNewArticles,
  getActiveArticleCodes,
  removeActiveArticle,
} from "./articleCache";
import { ARTICLE_DELETED, fetchDetail } from "./detailFetcher";
import { fetchHtml } from "./htmlFetcher";

const logger = createLogger("CRAWLER");

const matcherQueue = new Queue("matcher-queue", {
  connection: bullmqConnection,
  defaultJobOptions: {
    // Retention caps to prevent unbounded BullMQ growth in Redis.
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 * 7, count: 5000 },
  },
});

/** Concurrency limit for PTT HTTP requests to avoid rate limiting. */
const FETCH_CONCURRENCY = 5;

/** Lazily imported p-limit (ESM-only package). */
let _pLimit: ((concurrency: number) => <T>(fn: () => Promise<T>) => Promise<T>) | null = null;

/**
 * Get the p-limit function, importing it dynamically on first use.
 * @returns The p-limit concurrency limiter factory.
 */
async function getPLimit() {
  if (!_pLimit) {
    const mod = await import("p-limit");
    _pLimit = mod.default;
  }
  return _pLimit;
}

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

  // Filter new articles via Redis HASH timestamp comparison
  const newArticles = await filterNewArticles(boardName, articles);

  if (newArticles.length === 0) {
    logger.debug(`No new articles for ${boardName}`);
    return [];
  }

  // Insert new articles only (skip existing)
  const count = await insertNewArticles(newArticles);
  logger.info(`${boardName}: ${count} new articles saved`);

  // Update Redis cache (board:latest HASH + active:articles ZSET)
  await cacheArticles(boardName, newArticles);

  // Fetch detail pages for new articles (concurrent)
  await fetchDetailsForArticles(newArticles);

  // Dispatch matcher jobs for new articles (bulk add)
  await matcherQueue.addBulk(
    newArticles.map((article) => ({
      name: "match",
      data: {
        board: article.board,
        title: article.title,
        code: article.code,
        author: article.author,
        pushSum: article.pushSum,
        link: article.link,
      },
    })),
  );

  return newArticles;
}

/**
 * Update detail data for all active articles (within 24h window in Redis).
 * Skips articles where push counts and content have not changed.
 *
 * @returns Number of articles updated.
 */
export async function updateActiveArticles(): Promise<number> {
  const articles = await getActiveArticleCodes();

  if (articles.length === 0) {
    logger.debug("No active articles to update");
    return 0;
  }

  const pLimit = await getPLimit();
  const limit = pLimit(FETCH_CONCURRENCY);
  let updated = 0;
  let expired = 0;

  await Promise.allSettled(
    articles.map((article) =>
      limit(async () => {
        const detail = await fetchDetail(article.link);

        if (detail === ARTICLE_DELETED) {
          await removeActiveArticle(article.board, article.code);
          expired++;
          return;
        }

        if (!detail) return;

        const changed = await updateArticleDetail(article.code, detail);
        if (changed) updated++;
      }),
    ),
  );

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
 * Fetch detail pages for a batch of articles with concurrency control.
 * @param articles - Articles to fetch details for.
 */
async function fetchDetailsForArticles(articles: RawArticle[]): Promise<void> {
  const pLimit = await getPLimit();
  const limit = pLimit(FETCH_CONCURRENCY);
  let fetched = 0;

  await Promise.allSettled(
    articles.map((article) =>
      limit(async () => {
        const detail = await fetchDetail(article.link);

        if (detail === ARTICLE_DELETED) {
          await removeActiveArticle(article.board, article.code);
          return;
        }

        if (!detail) return;

        await updateArticleDetail(article.code, detail);
        fetched++;
      }),
    ),
  );

  logger.info(`Fetched details for ${fetched}/${articles.length} articles`);
}
