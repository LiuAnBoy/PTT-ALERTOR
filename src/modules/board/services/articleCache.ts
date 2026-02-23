import { redis } from "../../../core/redis";
import { logError } from "../../user/services/errorLogger";
import type { RawArticle } from "../types/article";
import { PTT_BASE_URL } from "./pttClient";

/** Redis HASH key: field=board, value=latest article timestamp. */
const BOARD_LATEST_KEY = "board:latest";

/** Redis ZSET key: score=timestamp, member={board}:{code}. */
const ACTIVE_ARTICLES_KEY = "active:articles";

/** Update window: only re-fetch articles from the last 24 hours. */
const UPDATE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Get the latest article timestamp for a board from Redis HASH.
 * @param board - The board name.
 * @returns The timestamp or null if no entry exists.
 */
export async function getLatestTimestamp(board: string): Promise<number | null> {
  const val = await redis.hget(BOARD_LATEST_KEY, board);
  if (val === null) return null;
  return Number(val);
}

/**
 * Set the latest article timestamp for a board in Redis HASH.
 * @param board - The board name.
 * @param timestamp - The latest article timestamp (seconds).
 */
export async function setLatestTimestamp(board: string, timestamp: number): Promise<void> {
  await redis.hset(BOARD_LATEST_KEY, board, timestamp);
}

/**
 * Remove a board's latest timestamp entry from Redis HASH.
 * Called when a board has no more subscribers.
 * @param board - The board name.
 */
export async function removeLatestTimestamp(board: string): Promise<void> {
  await redis.hdel(BOARD_LATEST_KEY, board);
}

/**
 * Check if a board has a latest timestamp entry in Redis HASH.
 * @param board - The board name.
 * @returns True if the board has an entry.
 */
export async function hasLatestTimestamp(board: string): Promise<boolean> {
  const exists = await redis.hexists(BOARD_LATEST_KEY, board);
  return exists === 1;
}

/**
 * Add articles to the active articles ZSET for detail crawling.
 * @param articles - Articles to add with board, code, and timestamp.
 */
export async function addActiveArticles(
  articles: { board: string; code: string; timestamp: number }[],
): Promise<void> {
  if (articles.length === 0) return;

  const pipe = redis.pipeline();
  for (const article of articles) {
    pipe.zadd(ACTIVE_ARTICLES_KEY, article.timestamp, `${article.board}:${article.code}`);
  }
  await pipe.exec();
}

/**
 * Remove an article from the active articles ZSET.
 * Called when an article is confirmed deleted (404).
 * @param board - The board name.
 * @param code - The article code.
 */
export async function removeActiveArticle(board: string, code: string): Promise<void> {
  await redis.zrem(ACTIVE_ARTICLES_KEY, `${board}:${code}`);
}

/**
 * Get active article codes from Redis ZSET (last 24 hours).
 * Parses member format {board}:{code} and reconstructs article links.
 * @returns Array of { code, board, link } for articles within the update window.
 */
export async function getActiveArticleCodes(): Promise<
  { code: string; board: string; link: string }[]
> {
  const minScore = Math.floor(Date.now() / 1000) - UPDATE_WINDOW_SECONDS;
  const members = await redis.zrangebyscore(ACTIVE_ARTICLES_KEY, minScore, "+inf");

  if (!members || members.length === 0) return [];

  return members.map((member) => {
    const sepIdx = member.indexOf(":");
    const board = member.slice(0, sepIdx);
    const code = member.slice(sepIdx + 1);
    return {
      code,
      board,
      link: `${PTT_BASE_URL}/bbs/${board}/${code}.html`,
    };
  });
}

/**
 * Filter articles that are new (timestamp > latest known for this board).
 * @param boardName - The board name.
 * @param articles - All fetched articles.
 * @returns Only articles newer than the latest cached timestamp.
 */
export async function filterNewArticles(
  boardName: string,
  articles: RawArticle[],
): Promise<RawArticle[]> {
  if (articles.length === 0) return [];

  const latest = await getLatestTimestamp(boardName);

  // No entry for this board → all articles are new (first crawl)
  if (latest === null) return articles;

  return articles.filter((article) => Number(article.timestamp) > latest);
}

/**
 * Cache articles after crawling: update board:latest HASH and active:articles ZSET.
 * @param boardName - The board name.
 * @param articles - Articles to cache.
 */
export async function cacheArticles(boardName: string, articles: RawArticle[]): Promise<void> {
  if (articles.length === 0) return;

  const pipe = redis.pipeline();

  // Find max timestamp and update board:latest HASH
  let maxTs = 0;
  for (const article of articles) {
    const ts = Number(article.timestamp);
    if (ts > maxTs) maxTs = ts;
    // Add to active:articles ZSET
    pipe.zadd(ACTIVE_ARTICLES_KEY, ts, `${boardName}:${article.code}`);
  }
  pipe.hset(BOARD_LATEST_KEY, boardName, maxTs);

  try {
    await pipe.exec();
  } catch (err) {
    await logError("FATAL", "CRAWLER", "Redis cacheArticles failed", {
      command: "zadd+hset",
      board: boardName,
      errorMsg: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Clean expired entries from the active articles ZSET.
 * Removes entries with timestamp older than the given cutoff.
 * @param beforeTimestamp - Remove articles with score below this.
 * @returns Number of entries removed.
 */
export async function cleanActiveArticles(beforeTimestamp: number): Promise<number> {
  return redis.zremrangebyscore(ACTIVE_ARTICLES_KEY, "-inf", beforeTimestamp);
}
