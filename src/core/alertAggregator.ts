import { createLogger } from "./logger";

const logger = createLogger("CRAWLER");

/** Possible states for the alert aggregator state machine. */
type AlertState = "NORMAL" | "ALERTING";

/**
 * In-memory singleton that aggregates crawler error alerts to prevent
 * notification flooding. Implements a simple NORMAL → ALERTING → NORMAL
 * state machine.
 */
class AlertAggregator {
  private state: AlertState = "NORMAL";
  private errorCounts: Map<string, number> = new Map();
  private totalErrors = 0;
  private startedAt: Date | null = null;

  /**
   * Record an error from a given module. On the first error the state
   * transitions from NORMAL to ALERTING and the timestamp is captured.
   * Subsequent errors are accumulated per module.
   * @param module - The module name where the error occurred.
   * @param message - A human-readable error description.
   */
  recordError(module: string, message: string): void {
    if (this.state === "NORMAL") {
      this.state = "ALERTING";
      this.startedAt = new Date();
      logger.warn(`Alert state entered — first error from [${module}]: ${message}`);
    }

    this.errorCounts.set(module, (this.errorCounts.get(module) ?? 0) + 1);
    this.totalErrors += 1;
  }

  /**
   * Build the first-alert message sent when the state transitions to ALERTING.
   * @returns A formatted string containing "爬蟲異常".
   */
  getFirstAlert(): string {
    const lines: string[] = ["⚠️ 爬蟲異常"];
    lines.push(`時間: ${this.startedAt?.toISOString() ?? "unknown"}`);
    return lines.join("\n");
  }

  /**
   * Build an aggregated summary of accumulated errors by module.
   * @returns A formatted string listing per-module counts and the total.
   */
  getSummary(): string {
    const lines: string[] = ["📊 錯誤統計摘要"];

    for (const [mod, count] of this.errorCounts) {
      lines.push(`  ${mod}: ${count}`);
    }

    lines.push(`總計: ${this.totalErrors}`);
    return lines.join("\n");
  }

  /**
   * Build a recovery message indicating the system returned to normal.
   * Includes duration and error stats from the ALERTING period.
   * @returns A formatted string containing "恢復正常".
   */
  getRecoveryMessage(): string {
    const now = new Date();
    const durationMs = this.startedAt ? now.getTime() - this.startedAt.getTime() : 0;
    const durationMin = Math.round(durationMs / 60_000);

    const lines: string[] = ["✅ 爬蟲恢復正常"];
    lines.push(`持續時間: ${durationMin} 分鐘`);
    lines.push(`累計錯誤: ${this.totalErrors}`);
    return lines.join("\n");
  }

  /**
   * Transition from ALERTING back to NORMAL and reset all counters.
   */
  recover(): void {
    logger.info(
      `Alert state recovered — total errors: ${this.totalErrors}, ` +
        `duration: ${this.startedAt ? Date.now() - this.startedAt.getTime() : 0}ms`,
    );
    this.state = "NORMAL";
    this.errorCounts.clear();
    this.totalErrors = 0;
    this.startedAt = null;
  }

  /**
   * Full reset of all internal state. Intended for testing.
   * @internal
   */
  reset(): void {
    this.state = "NORMAL";
    this.errorCounts.clear();
    this.totalErrors = 0;
    this.startedAt = null;
  }

  /**
   * Get the current state of the aggregator.
   * @returns "NORMAL" or "ALERTING".
   */
  getState(): AlertState {
    return this.state;
  }

  /**
   * Get a copy of the per-module error counts.
   * @returns A new Map with module names as keys and counts as values.
   */
  getErrorCounts(): Map<string, number> {
    return new Map(this.errorCounts);
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
}

/** Singleton instance for application-wide error alert aggregation. */
export const alertAggregator = new AlertAggregator();

export { AlertAggregator };
