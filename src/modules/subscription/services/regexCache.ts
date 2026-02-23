import isSafeRegex from "safe-regex2";

/** Maximum allowed length for a regex pattern. */
const MAX_PATTERN_LENGTH = 200;

/**
 * In-memory regex compilation cache.
 * Avoids recompiling the same pattern on every match.
 */
const cache = new Map<string, RegExp>();

/**
 * Check if a regex pattern is safe (no ReDoS risk).
 * @param pattern - The regex pattern string.
 * @returns True if the pattern is safe to use.
 */
export function isPatternSafe(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;

  try {
    return isSafeRegex(pattern);
  } catch {
    return false;
  }
}

/**
 * Get or compile a RegExp for the given pattern.
 * Rejects patterns that are unsafe (ReDoS risk) or too long.
 * @param pattern - The regex pattern string.
 * @returns The compiled RegExp, or null if compilation fails or pattern is unsafe.
 */
export function getRegex(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached) return cached;

  if (!isPatternSafe(pattern)) return null;

  try {
    const regex = new RegExp(pattern, "i");
    cache.set(pattern, regex);
    return regex;
  } catch {
    return null;
  }
}
