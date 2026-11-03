jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { alertAggregator } from "../alertAggregator";
import { crawlerCircuit } from "../circuitBreaker";
import { roundTracker } from "../roundTracker";

let recordRoundResult: jest.SpyInstance;

beforeEach(() => {
  roundTracker.reset();
  recordRoundResult = jest.spyOn(crawlerCircuit, "recordRoundResult");
});

afterEach(() => {
  recordRoundResult.mockRestore();
});

describe("roundTracker round accounting", () => {
  it("reports the round result exactly once when every board has answered", () => {
    roundTracker.startRound(3);

    roundTracker.recordFailure("Soho");
    roundTracker.recordFailure("CodeJob");
    expect(recordRoundResult).not.toHaveBeenCalled();

    roundTracker.recordFailure("ShuangHe");

    expect(recordRoundResult).toHaveBeenCalledTimes(1);
    expect(recordRoundResult).toHaveBeenCalledWith({ total: 3, failed: 3 });
  });

  it("ignores repeat results for a board so retries cannot inflate the failure count", () => {
    roundTracker.startRound(3);

    roundTracker.recordFailure("Soho");
    roundTracker.recordFailure("Soho"); // BullMQ retry
    roundTracker.recordFailure("Soho"); // circuit-open skip path
    roundTracker.recordFailure("CodeJob");
    roundTracker.recordFailure("ShuangHe");

    // Extra records after the round closed must not re-fire the result.
    roundTracker.recordFailure("CodeJob");
    roundTracker.recordFailure("ShuangHe");

    expect(recordRoundResult).toHaveBeenCalledTimes(1);
    expect(recordRoundResult).toHaveBeenCalledWith({ total: 3, failed: 3 });
  });

  it("keeps the first outcome of a board and counts mixed rounds correctly", () => {
    roundTracker.startRound(2);

    roundTracker.recordSuccess("Soho");
    roundTracker.recordFailure("Soho"); // late retry, must be ignored
    roundTracker.recordFailure("CodeJob");

    expect(recordRoundResult).toHaveBeenCalledTimes(1);
    expect(recordRoundResult).toHaveBeenCalledWith({ total: 2, failed: 1 });
  });

  it("clears the per-board dedup set when a new round starts", () => {
    roundTracker.startRound(1);
    roundTracker.recordFailure("Soho");
    expect(recordRoundResult).toHaveBeenCalledWith({ total: 1, failed: 1 });

    roundTracker.startRound(1);
    roundTracker.recordSuccess("Soho");

    expect(recordRoundResult).toHaveBeenCalledTimes(2);
    expect(recordRoundResult).toHaveBeenLastCalledWith({ total: 1, failed: 0 });
  });
});

describe("roundTracker cascading reset", () => {
  it("clears the alert aggregator (including new category/progress state)", () => {
    alertAggregator.recordError("HTTP_5XX");
    alertAggregator.recordError("TIMEOUT");
    alertAggregator.markProgressSent(new Date());
    expect(alertAggregator.getState()).toBe("ALERTING");

    roundTracker.reset();

    expect(alertAggregator.getState()).toBe("NORMAL");
    expect(alertAggregator.getTotalErrors()).toBe(0);
    expect(alertAggregator.getCategoryCounts().size).toBe(0);
    expect(alertAggregator.getStartedAt()).toBeNull();
    expect(alertAggregator.shouldSendProgress(new Date())).toBe(false);
  });

  it("drops in-flight round state so a stale record cannot close the next round", () => {
    roundTracker.startRound(2);
    roundTracker.recordFailure("Soho");

    roundTracker.reset();
    roundTracker.startRound(2);
    roundTracker.recordFailure("Soho");
    roundTracker.recordFailure("CodeJob");

    // A leftover "Soho" slot would swallow the new record and report failed: 1.
    expect(recordRoundResult).toHaveBeenCalledTimes(1);
    expect(recordRoundResult).toHaveBeenCalledWith({ total: 2, failed: 2 });
  });
});
