import isSafeRegex from "safe-regex2";

/** Maximum allowed length for a regex pattern. */
const MAX_PATTERN_LENGTH = 200;

/**
 * Escape special regex characters in a string for literal matching.
 * @param str - The string to escape.
 * @returns The escaped string safe for use in a RegExp constructor.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
 * Invalid regex is auto-escaped for literal matching.
 * Rejects patterns that are unsafe (ReDoS risk) or too long.
 * @param pattern - The regex pattern string.
 * @returns The compiled RegExp, or null if the pattern is unsafe.
 */
export function getRegex(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached) return cached;

  if (pattern.length > MAX_PATTERN_LENGTH) return null;

  try {
    const regex = new RegExp(pattern, "i");
    // Valid regex — check for ReDoS risk
    if (!isPatternSafe(pattern)) return null;
    cache.set(pattern, regex);
    return regex;
  } catch {
    // Invalid regex → escape for literal matching (no ReDoS risk)
    const regex = new RegExp(escapeRegex(pattern), "i");
    cache.set(pattern, regex);
    return regex;
  }
}
