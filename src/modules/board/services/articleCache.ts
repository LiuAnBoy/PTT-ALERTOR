import { redis } from "../../../core/redis";
import { logError } from "../../user/services/errorLogger";
import type { RawArticle } from "../types/article";

/**
 * Redis ZSET key for a board's article cache.
 * @param boardName - The board name.
 * @returns The Redis key string.
 */
function cacheKey(boardName: string): string {
  return `board:${boardName}:articles`;
}

/**
 * Filter articles that are new (not yet in Redis ZSET cache).
 * @param boardName - The board name.
 * @param articles - All fetched articles.
 * @returns Only articles not already cached.
 */
export async function filterNewArticles(
  boardName: string,
  articles: RawArticle[],
): Promise<RawArticle[]> {
  if (articles.length === 0) return [];

  const key = cacheKey(boardName);
  const pipeline = redis.pipeline();

  for (const article of articles) {
    pipeline.zscore(key, article.code);
  }

  let results;
  try {
    results = await pipeline.exec();
  } catch (err) {
    await logError("FATAL", "CRAWLER", "Redis filterNewArticles failed", {
      command: "zscore",
      key: cacheKey(boardName),
      errorMsg: (err as Error).message,
    });
    throw err;
  }
  if (!results) return articles;

  return articles.filter((_article, i) => {
    const [err, score] = results[i];
    return !err && score === null;
  });
}

/**
 * Add articles to the Redis ZSET cache.
 * @param boardName - The board name.
 * @param articles - Articles to cache.
 */
export async function cacheArticles(boardName: string, articles: RawArticle[]): Promise<void> {
  if (articles.length === 0) return;

  const key = cacheKey(boardName);
  const pipeline = redis.pipeline();

  for (const article of articles) {
    pipeline.zadd(key, Number(article.timestamp), article.code);
  }

  try {
    await pipeline.exec();
  } catch (err) {
    await logError("FATAL", "CRAWLER", "Redis cacheArticles failed", {
      command: "zadd",
      key,
      errorMsg: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Check if the article cache for a board is empty.
 * @param boardName - The board name.
 * @returns True if the cache has no entries.
 */
export async function isCacheEmpty(boardName: string): Promise<boolean> {
  const count = await redis.zcard(cacheKey(boardName));
  return count === 0;
}

/**
 * Remove expired articles from cache (older than given timestamp).
 * @param boardName - The board name.
 * @param beforeTimestamp - Remove articles with score below this.
 */
export async function cleanCache(boardName: string, beforeTimestamp: number): Promise<void> {
  const key = cacheKey(boardName);
  await redis.zremrangebyscore(key, "-inf", beforeTimestamp);
}
