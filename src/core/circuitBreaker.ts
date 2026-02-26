import { createLogger } from "./logger";

const logger = createLogger("CRAWLER");

/** Possible states of the circuit breaker. */
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Options for configuring a {@link CircuitBreaker} instance. */
interface CircuitBreakerOptions {
  /** Cooldown period in milliseconds before transitioning from OPEN to HALF_OPEN. */
  cooldownMs: number;
}

/** Result of a single crawl round. */
interface RoundResult {
  /** Total number of boards attempted. */
  total: number;
  /** Number of boards that failed. */
  failed: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  cooldownMs: 2 * 60 * 1000, // 2 minutes
};

/**
 * Circuit breaker for PTT crawler requests.
 *
 * State machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 *
 * - CLOSED: normal operation, requests are allowed.
 * - OPEN: all requests are blocked until cooldown elapses.
 * - HALF_OPEN: a probe request is allowed; success closes, failure reopens.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private openedAt: number | null = null;
  private readonly cooldownMs: number;

  /**
   * Create a new CircuitBreaker.
   * @param options - Optional configuration overrides.
   */
  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs;
  }

  /**
   * Record the result of a crawl round and transition state accordingly.
   *
   * - CLOSED + all failed (failed >= total, total > 0) -> OPEN
   * - HALF_OPEN + all failed -> OPEN
   * - HALF_OPEN + any success -> CLOSED
   * - OPEN -> no-op (transitions happen via {@link shouldAttempt})
   * @param result - The round result containing total and failed counts.
   */
  recordRoundResult(result: RoundResult): void {
    const { total, failed } = result;
    const allFailed = total > 0 && failed >= total;

    if (this.state === "CLOSED") {
      if (allFailed) {
        this.state = "OPEN";
        this.openedAt = Date.now();
        logger.warn(`Circuit OPEN: all ${total} boards failed`);
      }
      return;
    }

    if (this.state === "HALF_OPEN") {
      if (allFailed) {
        this.state = "OPEN";
        this.openedAt = Date.now();
        logger.warn("Circuit re-OPEN: probe round still failing");
      } else {
        this.state = "CLOSED";
        this.openedAt = null;
        logger.info("Circuit CLOSED: probe round succeeded");
      }
      return;
    }

    // OPEN state: no-op, transitions happen via shouldAttempt()
  }

  /**
   * Check whether a crawl attempt should proceed.
   *
   * - CLOSED or HALF_OPEN -> true
   * - OPEN + cooldown elapsed -> transition to HALF_OPEN, return true
   * - OPEN + cooldown not elapsed -> false
   * @returns Whether the caller should proceed with the crawl attempt.
   */
  shouldAttempt(): boolean {
    if (this.state === "CLOSED" || this.state === "HALF_OPEN") {
      return true;
    }

    // OPEN state
    const elapsed = Date.now() - (this.openedAt ?? 0);
    if (elapsed >= this.cooldownMs) {
      this.state = "HALF_OPEN";
      logger.info("Circuit HALF_OPEN: cooldown elapsed, allowing probe");
      return true;
    }

    return false;
  }

  /**
   * Check whether the circuit is currently open.
   * @returns True if the state is OPEN.
   */
  isOpen(): boolean {
    return this.state === "OPEN";
  }

  /**
   * Get the current circuit state.
   * @returns The current state string.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Reset the circuit to CLOSED state. Intended for testing.
   */
  reset(): void {
    this.state = "CLOSED";
    this.openedAt = null;
  }
}

/** Singleton circuit breaker for the PTT crawler. */
export const crawlerCircuit = new CircuitBreaker();
