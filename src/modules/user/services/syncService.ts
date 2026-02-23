import { createLogger } from "../../../core/logger";
import { getPrisma } from "../../../core/prisma";
import { redis } from "../../../core/redis";
import {
  addActiveArticles,
  cacheArticles,
  hasLatestTimestamp,
  removeLatestTimestamp,
  setLatestTimestamp,
} from "../../board/services/articleCache";
import { fetchHtml } from "../../board/services/htmlFetcher";

const logger = createLogger("SERVER");

/** Redis key for the set of all subscribed boards. */
const BOARDS_KEY = "boards";

/**
 * Redis key for the set of subscriber user IDs for a board.
 * Format: keyword:{board}:subs
 */
function subsKey(board: string): string {
  return `keyword:${board}:subs`;
}

/**
 * Redis key for a user's subscription keywords on a board.
 * Format: user:{userId}:board:{board}
 */
function userBoardKey(userId: string, board: string): string {
  return `user:${userId}:board:${board}`;
}

/**
 * Sync all subscriptions from PostgreSQL to Redis on startup.
 * Enables zero-DB-query matching by pre-loading data into Redis.
 *
 * Redis structures:
 * - SET boards → all subscribed board names
 * - SET keyword:{board}:subs → user IDs subscribed to this board
 * - SET user:{userId}:board:{board} → keywords for this user+board
 */
export async function syncSubscriptions(): Promise<void> {
  const subscriptions = await getPrisma().subscription.findMany();

  if (subscriptions.length === 0) {
    logger.info("Sync completed: 0 subscriptions loaded to Redis");
    return;
  }

  // Collect unique boards and group data
  const boards = new Set<string>();
  const boardSubs = new Map<string, Set<string>>(); // board → set of userIds
  const userKeywords = new Map<string, Set<string>>(); // userId:board → set of keywords

  for (const sub of subscriptions) {
    boards.add(sub.board);

    // Board subscriber set
    const subSet = boardSubs.get(sub.board) ?? new Set();
    subSet.add(sub.userId);
    boardSubs.set(sub.board, subSet);

    // User keywords per board
    const key = `${sub.userId}:${sub.board}`;
    const kwSet = userKeywords.get(key) ?? new Set();
    kwSet.add(sub.keyword);
    userKeywords.set(key, kwSet);
  }

  // Write to Redis via pipeline
  const pipe = redis.pipeline();

  // Clear old sync data
  pipe.del(BOARDS_KEY);
  for (const board of boards) {
    pipe.del(subsKey(board));
  }

  // Boards set
  if (boards.size > 0) {
    pipe.sadd(BOARDS_KEY, ...boards);
  }

  // Board subscriber sets
  for (const [board, userIds] of boardSubs) {
    pipe.sadd(subsKey(board), ...userIds);
  }

  // User keyword sets per board
  for (const [composite, keywords] of userKeywords) {
    const [userId, board] = [
      composite.slice(0, composite.lastIndexOf(":")),
      composite.slice(composite.lastIndexOf(":") + 1),
    ];
    const redisKey = userBoardKey(userId, board);
    pipe.del(redisKey);
    pipe.sadd(redisKey, ...keywords);
  }

  await pipe.exec();

  logger.info(
    `Sync completed: ${boards.size} boards, ${subscriptions.length} subscriptions loaded to Redis`,
  );
}

/**
 * Seed article cache from DB on startup.
 * Populates board:latest HASH and active:articles ZSET for all subscribed boards.
 * Must be called after syncSubscriptions() so the boards SET is available.
 */
export async function seedArticleCache(): Promise<void> {
  const boards = await redis.smembers(BOARDS_KEY);
  if (boards.length === 0) {
    logger.info("Seed skipped: no subscribed boards");
    return;
  }

  // Query recent articles (last 24h) for subscribed boards
  const cutoff = BigInt(Math.floor(Date.now() / 1000) - 24 * 60 * 60);

  const articles = await getPrisma().article.findMany({
    where: {
      board: { in: boards },
      timestamp: { gte: cutoff },
    },
    select: { code: true, board: true, timestamp: true },
  });

  if (articles.length === 0) {
    logger.info("Seed skipped: no recent articles in DB");
    return;
  }

  // Group by board to find max timestamp per board
  const boardMaxTs = new Map<string, number>();
  const activeItems: { board: string; code: string; timestamp: number }[] = [];

  for (const article of articles) {
    const ts = Number(article.timestamp);
    activeItems.push({ board: article.board, code: article.code, timestamp: ts });

    const current = boardMaxTs.get(article.board) ?? 0;
    if (ts > current) {
      boardMaxTs.set(article.board, ts);
    }
  }

  // Write board:latest HASH entries
  for (const [board, maxTs] of boardMaxTs) {
    await setLatestTimestamp(board, maxTs);
  }

  // Write active:articles ZSET entries
  await addActiveArticles(activeItems);

  logger.info(
    `Seed completed: ${boardMaxTs.size} boards, ${articles.length} articles loaded to Redis`,
  );
}

/**
 * Add a subscription to Redis (real-time sync).
 * Called after writing to DB when a user adds a subscription.
 *
 * @param userId - The user's UUID.
 * @param board - The board name.
 * @param keyword - The keyword to track.
 */
export async function addSubscriptionToRedis(
  userId: string,
  board: string,
  keyword: string,
): Promise<void> {
  // Seed article cache if this board has no latest entry yet,
  // so existing articles won't be treated as "new" on next crawl.
  // Uses Redis SET NX as a distributed lock to prevent duplicate seeding.
  const exists = await hasLatestTimestamp(board);
  if (!exists) {
    const lockKey = `lock:seed:${board}`;
    const acquired = await redis.set(lockKey, "1", "EX", 30, "NX");
    if (acquired) {
      try {
        const articles = await fetchHtml(board);
        await cacheArticles(board, articles);
        logger.info(`Seeded cache for ${board}: ${articles.length} articles`);
      } catch (err) {
        logger.warn(`Failed to seed cache for ${board}: ${(err as Error).message}`);
      }
    }
  }

  const pipe = redis.pipeline();
  pipe.sadd(BOARDS_KEY, board);
  pipe.sadd(subsKey(board), userId);
  pipe.sadd(userBoardKey(userId, board), keyword);
  await pipe.exec();

  logger.debug(`Redis sync: added ${board}/${keyword} for user ${userId}`);
}

/**
 * Remove a subscription from Redis (real-time sync).
 * Called after deleting from DB when a user removes a subscription.
 * Cleans up empty sets (user-board, board subscribers, boards list).
 *
 * @param userId - The user's UUID.
 * @param board - The board name.
 * @param keyword - The keyword to remove.
 */
export async function removeSubscriptionFromRedis(
  userId: string,
  board: string,
  keyword: string,
): Promise<void> {
  // Remove keyword from user's board set
  await redis.srem(userBoardKey(userId, board), keyword);

  // Check if user still has keywords on this board
  const remaining = await redis.scard(userBoardKey(userId, board));
  if (remaining === 0) {
    // Remove user from board subscriber set
    await redis.srem(subsKey(board), userId);

    // Check if anyone still subscribes to this board
    const boardSubs = await redis.scard(subsKey(board));
    if (boardSubs === 0) {
      // Remove board from boards set and clean up board:latest HASH
      await redis.srem(BOARDS_KEY, board);
      await removeLatestTimestamp(board);
    }
  }

  logger.debug(`Redis sync: removed ${board}/${keyword} for user ${userId}`);
}
