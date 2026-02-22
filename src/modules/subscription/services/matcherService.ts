import { createLogger } from "../../../core/logger";
import { redis } from "../../../core/redis";
import { logError } from "../../user/services/errorLogger";
import { getRegex } from "./regexCache";

const logger = createLogger("MATCHER");

/**
 * Match result containing user and matched keyword info.
 */
export interface MatchResult {
  userId: string;
  keyword: string;
}

/**
 * Match a new article title against all subscribers for the given board.
 * Non-DB Operation: all data comes from Redis.
 *
 * @param board - The board name.
 * @param title - The article title to match against.
 * @returns Array of matched user+keyword pairs.
 */
export async function matchArticle(board: string, title: string): Promise<MatchResult[]> {
  // Get all subscriber user IDs for this board
  const userIds = await redis.smembers(`keyword:${board}:subs`);
  if (userIds.length === 0) return [];

  const matches: MatchResult[] = [];

  for (const userId of userIds) {
    // Get user's keywords for this board
    const keywords = await redis.smembers(`user:${userId}:board:${board}`);

    for (const keyword of keywords) {
      if (matchKeyword(title, keyword, userId)) {
        matches.push({ userId, keyword });
      }
    }
  }

  if (matches.length > 0) {
    logger.debug(`Matched ${matches.length} subscriptions for "${title}" on ${board}`);
  }

  return matches;
}

/**
 * Check if an article title matches a keyword.
 * Supports plain text (case-insensitive) and regexp: prefix patterns.
 *
 * @param title - The article title.
 * @param keyword - The keyword or regex pattern.
 * @param userId - The user ID (for error logging).
 * @returns True if matched.
 */
/**
 * @internal Exported for unit testing only.
 */
export function matchKeyword(title: string, keyword: string, userId: string): boolean {
  if (keyword.startsWith("regexp:")) {
    const pattern = keyword.slice(7);
    const regex = getRegex(pattern);
    if (!regex) {
      logError("WARN", "MATCHER", `Regex compile failed: ${pattern}`, {
        keyword,
        userId,
        errorMsg: `Invalid regex: ${pattern}`,
      });
      return false;
    }
    return regex.test(title);
  }

  // Plain text: case-insensitive substring match
  return title.toLowerCase().includes(keyword.toLowerCase());
}
