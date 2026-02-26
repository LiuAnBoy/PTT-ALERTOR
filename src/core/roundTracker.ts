import { alertAggregator } from "./alertAggregator";
import { crawlerCircuit } from "./circuitBreaker";
import { createLogger } from "./logger";

const logger = createLogger("CRAWLER");

/**
 * Tracks per-dispatch-round success/failure counts and coordinates
 * between the circuit breaker and the alert aggregator.
 */
class RoundTracker {
  private expectedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private roundId = 0;

  /** Start a new round. Called after dispatching jobs. */
  startRound(boardCount: number): void {
    this.roundId++;
    this.expectedCount = boardCount;
    this.completedCount = 0;
    this.failedCount = 0;
    logger.debug(`Round ${this.roundId} started: ${boardCount} boards`);
  }

  /** Record a successful crawl job completion. */
  recordSuccess(): void {
    this.completedCount++;
    this.checkRoundComplete();
  }

  /** Record a crawl job failure. */
  recordFailure(): void {
    this.completedCount++;
    this.failedCount++;
    this.checkRoundComplete();
  }

  /** Whether the circuit breaker is blocking requests. */
  isCircuitOpen(): boolean {
    return !crawlerCircuit.shouldAttempt();
  }

  /** Get current circuit breaker state for logging. */
  getCircuitState(): string {
    return crawlerCircuit.getState();
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.expectedCount = 0;
    this.completedCount = 0;
    this.failedCount = 0;
    this.roundId = 0;
    crawlerCircuit.reset();
    alertAggregator.reset();
  }

  private checkRoundComplete(): void {
    if (this.completedCount < this.expectedCount) return;
    const result = { total: this.expectedCount, failed: this.failedCount };
    logger.info(`Round ${this.roundId} complete: ${this.failedCount}/${this.expectedCount} failed`);
    crawlerCircuit.recordRoundResult(result);
  }
}

export const roundTracker = new RoundTracker();
