/**
 * Coarse error categories used to summarise crawler failures in admin alerts.
 * The goal is a human-readable "what went wrong" breakdown, not exhaustive detail.
 */
export type ErrorCategory = "HTTP_5XX" | "HTTP_4XX" | "TIMEOUT" | "PARSE" | "OTHER";

/** Lowercase tokens that indicate a network timeout / connection-level failure. */
const TIMEOUT_TOKENS = ["etimedout", "econnreset", "econnrefused", "econnaborted", "timeout"];

/**
 * Shape of the structured `detail` object passed to {@link classifyError}.
 * All fields are optional and defensively type-checked at runtime.
 */
interface ErrorDetail {
  /** Explicit marker set by producers when the failure is a parsing error. */
  kind?: unknown;
  /** HTTP status code (only used when it is a finite number). */
  httpStatus?: unknown;
  /** Axios / generic error message. */
  errorMsg?: unknown;
  /** Alternative error message field used by some call sites. */
  error?: unknown;
  /** Parse error message field used by some call sites. */
  parseError?: unknown;
}

/**
 * Classify a crawler error into a coarse category based on its structured detail.
 *
 * Classification is driven entirely by structured fields — never by matching
 * the human-readable message string — so that generic fetch messages such as
 * "HTML fetch failed" are not mistaken for parse failures.
 *
 * Precedence (first match wins):
 * 1. `detail.kind === "parse"` → PARSE
 * 2. numeric `httpStatus` in 500–599 → HTTP_5XX
 * 3. numeric `httpStatus` in 400–499 → HTTP_4XX
 * 4. timeout/connection token in any message field → TIMEOUT
 * 5. otherwise → OTHER
 *
 * @param detail - The structured error detail (the 4th argument of `logError`).
 * @returns The matched error category.
 */
export function classifyError(detail?: unknown): ErrorCategory {
  const d = (typeof detail === "object" && detail !== null ? detail : {}) as ErrorDetail;

  if (d.kind === "parse") return "PARSE";

  const status = d.httpStatus;
  if (typeof status === "number" && Number.isFinite(status)) {
    if (status >= 500 && status <= 599) return "HTTP_5XX";
    if (status >= 400 && status <= 499) return "HTTP_4XX";
  }

  const text = [d.errorMsg, d.error, d.parseError]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (TIMEOUT_TOKENS.some((token) => text.includes(token))) return "TIMEOUT";

  return "OTHER";
}

/** Human-readable Traditional Chinese labels for each error category. */
export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  HTTP_5XX: "PTT 伺服器錯誤(5xx)",
  HTTP_4XX: "用戶端/權限錯誤(4xx)",
  TIMEOUT: "連線逾時/中斷",
  PARSE: "頁面解析失敗",
  OTHER: "其他錯誤",
};
