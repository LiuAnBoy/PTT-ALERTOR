import { dayjs } from "./dayjs";
import type { ErrorCategory } from "./errorClassifier";
import { CATEGORY_LABELS } from "./errorClassifier";
import { createLogger } from "./logger";

const logger = createLogger("CRAWLER");

/** Minimum gap between progress alerts while the outage is ongoing. */
const PROGRESS_INTERVAL_MS = 30 * 60_000;

/** Consecutive failing rounds before the first alert. One round is one dispatch tick (1 minute). */
const ALERT_AFTER_FAILING_ROUNDS = 5;

/** Consecutive clean rounds before an ongoing alert is reported as recovered. */
const RECOVER_AFTER_CLEAN_ROUNDS = 3;

/** Possible states for the alert aggregator state machine. */
type AlertState = "NORMAL" | "ALERTING";

/** What the caller must send after a round closes. */
export type RoundOutcome = "alert" | "recover" | "none";

/**
 * In-memory singleton that aggregates crawler error alerts to prevent
 * notification flooding. Implements a round-based NORMAL → ALERTING → NORMAL
 * state machine and classifies errors so alerts can describe what went wrong.
 * Errors only accumulate; the state changes when a round closes, so a transient
 * error that clears within a few rounds alerts nobody.
 *
 * NOTE: state is process-local. All workers run in the same Node process, so a
 * synchronous "mark before send" guard is sufficient against same-event-loop
 * duplicate sends. A multi-process / multi-container deployment would require
 * Redis-backed throttling instead.
 */
class AlertAggregator {
  private state: AlertState = "NORMAL";
  private categoryCounts: Map<ErrorCategory, number> = new Map();
  private totalErrors = 0;
  private startedAt: Date | null = null;
  private firstCategory: ErrorCategory | null = null;
  private lastProgressAt: Date | null = null;
  private errorsThisRound = 0;
  private failingRounds = 0;
  private cleanRounds = 0;

  /**
   * Record a classified error. The first error of a streak captures the start time and the
   * first category; every error accumulates per category and marks the current round as failing.
   * @param category - The coarse category of the error.
   */
  recordError(category: ErrorCategory): void {
    if (this.startedAt === null) this.startedAt = new Date();
    if (this.firstCategory === null) this.firstCategory = category;

    this.categoryCounts.set(category, (this.categoryCounts.get(category) ?? 0) + 1);
    this.totalErrors += 1;
    this.errorsThisRound += 1;
  }

  /**
   * Close the current round and advance the state machine. A round fails when an error was
   * recorded in it or the circuit is not CLOSED (an open circuit crawls nothing, so it records
   * no errors). A clean round before the alert threshold discards the streak.
   * @param circuitClosed - Whether the circuit breaker is CLOSED.
   * @returns "alert" when the first alert is due, "recover" when the recovery report is due.
   */
  closeRound(circuitClosed: boolean): RoundOutcome {
    const failing = this.errorsThisRound > 0 || !circuitClosed;
    this.errorsThisRound = 0;

    if (failing) {
      this.cleanRounds = 0;
      this.failingRounds += 1;
      if (this.startedAt === null) this.startedAt = new Date();
      if (this.state === "NORMAL" && this.failingRounds >= ALERT_AFTER_FAILING_ROUNDS) {
        this.state = "ALERTING";
        this.lastProgressAt = new Date();
        logger.warn(`Alert state entered after ${this.failingRounds} failing rounds`);
        return "alert";
      }
      return "none";
    }

    this.failingRounds = 0;
    if (this.state === "NORMAL") {
      if (this.totalErrors > 0) {
        logger.info(`Error streak cleared without alerting: ${this.totalErrors} errors`);
      }
      this.clear();
      return "none";
    }

    this.cleanRounds += 1;
    return this.cleanRounds >= RECOVER_AFTER_CLEAN_ROUNDS ? "recover" : "none";
  }

  /**
   * Build the first-alert message sent when a round's outcome is "alert".
   * @returns A formatted string containing "爬蟲異常".
   */
  getFirstAlert(): string {
    const lines = [
      "⚠️ 爬蟲異常偵測",
      `時間：${this.formatTime(this.startedAt)}`,
      `首個錯誤：${this.firstCategory ? CATEGORY_LABELS[this.firstCategory] : "未知"}`,
      `已連續 ${ALERT_AFTER_FAILING_ROUNDS} 輪異常`,
    ];
    return lines.join("\n");
  }

  /**
   * Build a progress alert for an ongoing outage (sent at most every 30 minutes).
   * @returns A formatted string summarising elapsed time and accumulated errors.
   */
  getProgressAlert(): string {
    const lines = [
      "⏳ 爬蟲持續異常中",
      `已持續：${this.durationMinutes(new Date())} 分鐘 ｜ 累計：${this.totalErrors} 次`,
      "主要原因：",
      ...this.breakdownLines(),
    ];
    return lines.join("\n");
  }

  /**
   * Build a recovery report covering the outage period, total errors and the
   * per-category breakdown. MUST be called BEFORE {@link recover}, which clears
   * the counters this report reads from.
   * @returns A formatted string containing "恢復正常".
   */
  getRecoveryMessage(): string {
    const now = new Date();
    const lines = [
      "✅ 爬蟲已恢復正常",
      "───────────────",
      `異常期間：${this.formatTime(this.startedAt)} ~ ${this.formatTime(now)}` +
        `（共 ${this.durationMinutes(now)} 分鐘）`,
      `累計錯誤：${this.totalErrors} 次`,
      "問題分布：",
      ...this.breakdownLines(),
    ];
    return lines.join("\n");
  }

  /**
   * Whether a progress alert is due: in ALERTING state and at least
   * PROGRESS_INTERVAL_MS has elapsed since the last progress alert / outage start.
   * @param now - The current time.
   * @returns True if a progress alert should be sent.
   */
  shouldSendProgress(now: Date): boolean {
    if (this.state !== "ALERTING" || this.lastProgressAt === null) return false;
    return now.getTime() - this.lastProgressAt.getTime() >= PROGRESS_INTERVAL_MS;
  }

  /**
   * Update the progress baseline. Call synchronously BEFORE awaiting the send,
   * so concurrent callers in the same event loop cannot both pass the throttle.
   * @param now - The time the progress alert was sent.
   */
  markProgressSent(now: Date): void {
    this.lastProgressAt = now;
  }

  /**
   * Transition from ALERTING back to NORMAL and reset all counters.
   */
  recover(): void {
    logger.info(
      `Alert state recovered — total errors: ${this.totalErrors}, ` +
        `duration: ${this.startedAt ? Date.now() - this.startedAt.getTime() : 0}ms`,
    );
    this.clear();
  }

  /**
   * Full reset of all internal state. Intended for testing and cascading resets.
   * @internal
   */
  reset(): void {
    this.clear();
  }

  /**
   * Get the current state of the aggregator.
   * @returns "NORMAL" or "ALERTING".
   */
  getState(): AlertState {
    return this.state;
  }

  /**
   * Get a copy of the per-category error counts.
   * @returns A new Map with categories as keys and counts as values.
   */
  getCategoryCounts(): Map<ErrorCategory, number> {
    return new Map(this.categoryCounts);
  }

  /**
   * Get the total number of errors recorded since the last reset/recover.
   * @returns Total error count.
   */
  getTotalErrors(): number {
    return this.totalErrors;
  }

  /**
   * Get the timestamp when the ALERTING state started.
   * @returns The Date when alerting began, or null if in NORMAL state.
   */
  getStartedAt(): Date | null {
    return this.startedAt;
  }

  /** Reset every field back to the NORMAL initial state. */
  private clear(): void {
    this.state = "NORMAL";
    this.categoryCounts.clear();
    this.totalErrors = 0;
    this.startedAt = null;
    this.firstCategory = null;
    this.lastProgressAt = null;
    this.errorsThisRound = 0;
    this.failingRounds = 0;
    this.cleanRounds = 0;
  }

  /** Format a timestamp in the Asia/Taipei timezone, or "unknown" if null. */
  private formatTime(date: Date | null): string {
    return date ? dayjs(date).tz().format("YYYY-MM-DD HH:mm") : "unknown";
  }

  /** Whole minutes elapsed since the outage started. */
  private durationMinutes(now: Date): number {
    if (!this.startedAt) return 0;
    return Math.round((now.getTime() - this.startedAt.getTime()) / 60_000);
  }

  /** Per-category breakdown lines, sorted by count descending. */
  private breakdownLines(): string[] {
    return [...this.categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `  • ${CATEGORY_LABELS[category]}：${count} 次`);
  }
}

/** Singleton instance for application-wide error alert aggregation. */
export const alertAggregator = new AlertAggregator();

export { AlertAggregator };
