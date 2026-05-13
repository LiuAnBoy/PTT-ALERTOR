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
 * Uses pipeline to batch Redis queries for all subscribers.
 *
 * @param board - The board name.
 * @param title - The article title to match against.
 * @returns Array of matched user+keyword pairs.
 */
export async function matchArticle(board: string, title: string): Promise<MatchResult[]> {
  // Get all subscriber user IDs for this board
  const userIds = await redis.smembers(`keyword:${board}:subs`);
  if (userIds.length === 0) return [];

  // Batch fetch all user keywords via pipeline
  const pipe = redis.pipeline();
  for (const userId of userIds) {
    pipe.smembers(`user:${userId}:board:${board}`);
  }
  const results = await pipe.exec();

  const matches: MatchResult[] = [];

  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    const [err, keywords] = (results?.[i] ?? [null, []]) as [Error | null, string[]];
    if (err || !keywords) continue;

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
 * Check if an article title matches a keyword using regex.
 * All keywords are treated as regex patterns. Invalid regex is auto-escaped for literal matching.
 * Legacy keywords with "regexp:" prefix are handled for backward compatibility.
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
  // Backward compatibility: strip legacy regexp: prefix
  const stripped = keyword.startsWith("regexp:") ? keyword.slice(7) : keyword;

  // AND mode: keyword contains '&' — every sub-pattern must match.
  // Note: '&' is not a regex special char, so we don't lose any common patterns.
  const subPatterns = stripped.includes("&")
    ? stripped
        .split("&")
        .map((p) => p.trim())
        .filter(Boolean)
    : [stripped];

  for (const pattern of subPatterns) {
    const regex = getRegex(pattern);
    if (!regex) {
      logError("WARN", "MATCHER", `Regex compile failed: ${pattern}`, {
        keyword,
        userId,
        errorMsg: `Unsafe regex: ${pattern}`,
      });
      return false;
    }
    if (!regex.test(title)) return false;
  }
  return true;
}
