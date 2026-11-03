import { alertAggregator } from "./alertAggregator";
import { crawlerCircuit } from "./circuitBreaker";
import { createLogger } from "./logger";

const logger = createLogger("CRAWLER");

/**
 * Tracks per-dispatch-round success/failure counts and coordinates
 * between the circuit breaker and the alert aggregator.
 *
 * A board contributes exactly one outcome per round: the first one recorded
 * wins and every later record for that board is ignored. This is required
 * because a single crawl job can re-enter the worker several times — BullMQ
 * retries it, and once the circuit opens the retry takes the skip path — which
 * would otherwise inflate the failure count above the board count and re-fire
 * the round result on every extra record.
 *
 * Known limitation: a retry belonging to round N can land after round N+1 has
 * started and claim that board's slot. Retries finish well inside the 1-minute
 * dispatch interval, so this is rare and self-corrects on the next round.
 */
class RoundTracker {
  private expectedCount = 0;
  private failedCount = 0;
  private roundId = 0;
  private recordedBoards = new Set<string>();
  private roundClosed = false;

  /**
   * Start a new round. Called after dispatching jobs.
   * @param boardCount - Number of boards dispatched in this round.
   */
  startRound(boardCount: number): void {
    this.roundId++;
    this.expectedCount = boardCount;
    this.failedCount = 0;
    this.recordedBoards.clear();
    this.roundClosed = false;
    logger.debug(`Round ${this.roundId} started: ${boardCount} boards`);
  }

  /**
   * Record a successful crawl job completion.
   * @param boardName - The board that was crawled.
   */
  recordSuccess(boardName: string): void {
    if (!this.claimBoard(boardName)) return;
    this.checkRoundComplete();
  }

  /**
   * Record a crawl job failure.
   * @param boardName - The board that failed to crawl.
   */
  recordFailure(boardName: string): void {
    if (!this.claimBoard(boardName)) return;
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
    this.failedCount = 0;
    this.roundId = 0;
    this.recordedBoards.clear();
    this.roundClosed = false;
    crawlerCircuit.reset();
    alertAggregator.reset();
  }

  /**
   * Claim this round's single outcome slot for a board.
   * @param boardName - The board being recorded.
   * @returns True if the board had not been recorded yet in this round.
   */
  private claimBoard(boardName: string): boolean {
    if (this.recordedBoards.has(boardName)) {
      logger.debug(`Round ${this.roundId}: ignoring duplicate result for ${boardName}`);
      return false;
    }
    this.recordedBoards.add(boardName);
    return true;
  }

  private checkRoundComplete(): void {
    if (this.roundClosed) return;
    if (this.recordedBoards.size < this.expectedCount) return;
    this.roundClosed = true;
    const result = { total: this.expectedCount, failed: this.failedCount };
    logger.info(`Round ${this.roundId} complete: ${this.failedCount}/${this.expectedCount} failed`);
    crawlerCircuit.recordRoundResult(result);
  }
}

export const roundTracker = new RoundTracker();
