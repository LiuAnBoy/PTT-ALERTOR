jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import type { RoundOutcome } from "../alertAggregator";
import { AlertAggregator } from "../alertAggregator";

const THIRTY_MIN_MS = 30 * 60_000;

let aggregator: AlertAggregator;

/**
 * Close `count` rounds that each recorded an error.
 * @returns The outcome of the last round.
 */
function failRounds(count: number): RoundOutcome {
  let outcome: RoundOutcome = "none";
  for (let i = 0; i < count; i++) {
    aggregator.recordError("HTTP_5XX");
    outcome = aggregator.closeRound(true);
  }
  return outcome;
}

/**
 * Close `count` rounds with no errors and the circuit closed.
 * @returns The outcome of the last round.
 */
function cleanRounds(count: number): RoundOutcome {
  let outcome: RoundOutcome = "none";
  for (let i = 0; i < count; i++) outcome = aggregator.closeRound(true);
  return outcome;
}

beforeEach(() => {
  aggregator = new AlertAggregator();
});

// ── State transitions ──────────────────────────────────────────────────────

describe("state transitions", () => {
  it("should start in NORMAL state", () => {
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should stay NORMAL on errors until a round closes", () => {
    aggregator.recordError("TIMEOUT");
    aggregator.recordError("HTTP_4XX");
    expect(aggregator.getState()).toBe("NORMAL");
  });
});

// ── Rounds ─────────────────────────────────────────────────────────────────

describe("closeRound", () => {
  it("should alert exactly on the fifth consecutive failing round", () => {
    expect(failRounds(4)).toBe("none");
    expect(aggregator.getState()).toBe("NORMAL");

    expect(failRounds(1)).toBe("alert");
    expect(aggregator.getState()).toBe("ALERTING");

    expect(failRounds(1)).toBe("none");
  });

  it("should discard the streak on a clean round before the threshold", () => {
    failRounds(4);
    cleanRounds(1);

    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
    expect(failRounds(4)).toBe("none");
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should count many errors in one round as one failing round", () => {
    for (let i = 0; i < 20; i++) aggregator.recordError("HTTP_5XX");
    expect(aggregator.closeRound(true)).toBe("none");
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should count a tick with the circuit not CLOSED as failing even with no errors", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.closeRound(true);
    for (let i = 0; i < 3; i++) expect(aggregator.closeRound(false)).toBe("none");

    expect(aggregator.closeRound(false)).toBe("alert");
  });

  it("should report recovery only after three consecutive clean rounds", () => {
    failRounds(5);

    expect(cleanRounds(2)).toBe("none");
    expect(cleanRounds(1)).toBe("recover");
  });

  it("should restart the clean count when a round fails during recovery", () => {
    failRounds(5);
    cleanRounds(2);
    failRounds(1);

    expect(cleanRounds(2)).toBe("none");
    expect(aggregator.getState()).toBe("ALERTING");
    expect(cleanRounds(1)).toBe("recover");
  });

  it("should not count a tick with the circuit not CLOSED as clean", () => {
    failRounds(5);
    cleanRounds(2);

    expect(aggregator.closeRound(false)).toBe("none");
    expect(cleanRounds(2)).toBe("none");
  });

  it("should keep the first category and the streak's start time", () => {
    aggregator.recordError("TIMEOUT");
    const started = aggregator.getStartedAt();
    aggregator.closeRound(true);
    failRounds(4);

    expect(aggregator.getStartedAt()).toBe(started);
    expect(aggregator.getFirstAlert()).toContain("連線逾時/中斷");
  });
});

// ── Error accumulation ─────────────────────────────────────────────────────

describe("error accumulation", () => {
  it("should count errors per category", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("TIMEOUT");

    const counts = aggregator.getCategoryCounts();
    expect(counts.get("HTTP_5XX")).toBe(2);
    expect(counts.get("TIMEOUT")).toBe(1);
  });

  it("should track total errors", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("TIMEOUT");

    expect(aggregator.getTotalErrors()).toBe(3);
  });

  it("should return a copy of category counts (not the internal map)", () => {
    aggregator.recordError("HTTP_5XX");
    const counts = aggregator.getCategoryCounts();
    counts.set("HTTP_5XX", 999);

    expect(aggregator.getCategoryCounts().get("HTTP_5XX")).toBe(1);
  });
});

// ── startedAt tracking ─────────────────────────────────────────────────────

describe("startedAt tracking", () => {
  it("should be null with no errors", () => {
    expect(aggregator.getStartedAt()).toBeNull();
  });

  it("should be set by the first error", () => {
    const before = new Date();
    aggregator.recordError("HTTP_5XX");
    const after = new Date();

    const startedAt = aggregator.getStartedAt();
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(startedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should keep the original startedAt on subsequent errors", () => {
    aggregator.recordError("HTTP_5XX");
    const first = aggregator.getStartedAt();

    aggregator.recordError("HTTP_5XX");
    expect(aggregator.getStartedAt()).toBe(first);
  });
});

// ── getFirstAlert ──────────────────────────────────────────────────────────

describe("getFirstAlert", () => {
  it('should contain "爬蟲異常"', () => {
    aggregator.recordError("HTTP_5XX");
    expect(aggregator.getFirstAlert()).toContain("爬蟲異常");
  });

  it("should describe the first error category", () => {
    aggregator.recordError("HTTP_5XX");
    expect(aggregator.getFirstAlert()).toContain("PTT 伺服器錯誤(5xx)");
  });

  it("should state the number of failing rounds", () => {
    aggregator.recordError("HTTP_5XX");
    expect(aggregator.getFirstAlert()).toContain("已連續 5 輪異常");
  });
});

// ── getProgressAlert ───────────────────────────────────────────────────────

describe("getProgressAlert", () => {
  it("should include accumulated total and per-category breakdown", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("TIMEOUT");

    const alert = aggregator.getProgressAlert();
    expect(alert).toContain("爬蟲持續異常中");
    expect(alert).toContain("累計：3 次");
    expect(alert).toContain("PTT 伺服器錯誤(5xx)：2 次");
    expect(alert).toContain("連線逾時/中斷：1 次");
  });

  it("should sort the breakdown by count descending", () => {
    aggregator.recordError("TIMEOUT");
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("HTTP_5XX");

    const alert = aggregator.getProgressAlert();
    expect(alert.indexOf("PTT 伺服器錯誤(5xx)")).toBeLessThan(alert.indexOf("連線逾時/中斷"));
  });
});

// ── getRecoveryMessage ─────────────────────────────────────────────────────

describe("getRecoveryMessage", () => {
  it('should contain "恢復正常"', () => {
    aggregator.recordError("HTTP_5XX");
    expect(aggregator.getRecoveryMessage()).toContain("恢復正常");
  });

  it("should include the outage period, total and breakdown", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("HTTP_5XX");

    const msg = aggregator.getRecoveryMessage();
    expect(msg).toContain("異常期間：");
    expect(msg).toContain("分鐘");
    expect(msg).toContain("累計錯誤：2 次");
    expect(msg).toContain("PTT 伺服器錯誤(5xx)：2 次");
  });
});

// ── progress throttle ──────────────────────────────────────────────────────

describe("progress throttle", () => {
  /**
   * Enter ALERTING and read the moment the progress baseline was set.
   * @returns A time just after the alert fired.
   */
  function enterAlerting(): number {
    failRounds(5);
    return Date.now();
  }

  it("should never send progress in NORMAL state", () => {
    aggregator.recordError("HTTP_5XX");
    expect(aggregator.shouldSendProgress(new Date(Date.now() + THIRTY_MIN_MS * 2))).toBe(false);
  });

  it("should not send before 30 minutes have elapsed since the alert", () => {
    const alertedAt = enterAlerting();

    expect(aggregator.shouldSendProgress(new Date(alertedAt + THIRTY_MIN_MS - 1000))).toBe(false);
  });

  it("should send once 30 minutes have elapsed since the alert", () => {
    const alertedAt = enterAlerting();

    expect(aggregator.shouldSendProgress(new Date(alertedAt + THIRTY_MIN_MS))).toBe(true);
  });

  it("should require another 30 minutes after marking progress sent", () => {
    const alertedAt = enterAlerting();

    const firstSend = new Date(alertedAt + THIRTY_MIN_MS);
    aggregator.markProgressSent(firstSend);

    expect(
      aggregator.shouldSendProgress(new Date(firstSend.getTime() + THIRTY_MIN_MS - 1000)),
    ).toBe(false);
    expect(aggregator.shouldSendProgress(new Date(firstSend.getTime() + THIRTY_MIN_MS))).toBe(true);
  });

  it("should not reset the progress baseline on later failing rounds", () => {
    const alertedAt = enterAlerting();

    failRounds(3);

    expect(aggregator.shouldSendProgress(new Date(alertedAt + THIRTY_MIN_MS))).toBe(true);
  });
});

// ── recover ────────────────────────────────────────────────────────────────

describe("recover", () => {
  it("should transition ALERTING → NORMAL", () => {
    failRounds(5);
    expect(aggregator.getState()).toBe("ALERTING");

    aggregator.recover();
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should reset all counters, so the next streak needs five rounds again", () => {
    failRounds(5);
    aggregator.recordError("TIMEOUT");
    aggregator.recover();

    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getCategoryCounts().size).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
    expect(failRounds(4)).toBe("none");
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("should clear all state back to initial", () => {
    failRounds(5);
    aggregator.markProgressSent(new Date());
    aggregator.reset();

    expect(aggregator.getState()).toBe("NORMAL");
    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getCategoryCounts().size).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
    expect(aggregator.shouldSendProgress(new Date())).toBe(false);
  });
});
