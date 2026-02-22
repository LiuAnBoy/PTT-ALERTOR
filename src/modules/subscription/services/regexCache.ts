/**
 * In-memory regex compilation cache.
 * Avoids recompiling the same pattern on every match.
 */
const cache = new Map<string, RegExp>();

/**
 * Get or compile a RegExp for the given pattern.
 * @param pattern - The regex pattern string.
 * @returns The compiled RegExp, or null if compilation fails.
 */
export function getRegex(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached) return cached;

  try {
    const regex = new RegExp(pattern, "i");
    cache.set(pattern, regex);
    return regex;
  } catch {
    return null;
  }
}
