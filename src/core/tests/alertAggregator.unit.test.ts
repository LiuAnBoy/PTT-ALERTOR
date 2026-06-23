jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { AlertAggregator } from "../alertAggregator";

const THIRTY_MIN_MS = 30 * 60_000;

let aggregator: AlertAggregator;

beforeEach(() => {
  aggregator = new AlertAggregator();
});

// ── State transitions ──────────────────────────────────────────────────────

describe("state transitions", () => {
  it("should start in NORMAL state", () => {
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should transition NORMAL → ALERTING on first error", () => {
    aggregator.recordError("TIMEOUT");
    expect(aggregator.getState()).toBe("ALERTING");
  });

  it("should remain in ALERTING on subsequent errors", () => {
    aggregator.recordError("TIMEOUT");
    aggregator.recordError("HTTP_4XX");
    expect(aggregator.getState()).toBe("ALERTING");
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
  it("should be null in NORMAL state", () => {
    expect(aggregator.getStartedAt()).toBeNull();
  });

  it("should be set when entering ALERTING state", () => {
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
  it("should never send progress in NORMAL state", () => {
    expect(aggregator.shouldSendProgress(new Date())).toBe(false);
  });

  it("should not send before 30 minutes have elapsed", () => {
    aggregator.recordError("HTTP_5XX");
    const start = aggregator.getStartedAt()!;

    const justUnder = new Date(start.getTime() + THIRTY_MIN_MS - 1000);
    expect(aggregator.shouldSendProgress(justUnder)).toBe(false);
  });

  it("should send once 30 minutes have elapsed", () => {
    aggregator.recordError("HTTP_5XX");
    const start = aggregator.getStartedAt()!;

    const atThreshold = new Date(start.getTime() + THIRTY_MIN_MS);
    expect(aggregator.shouldSendProgress(atThreshold)).toBe(true);
  });

  it("should require another 30 minutes after marking progress sent", () => {
    aggregator.recordError("HTTP_5XX");
    const start = aggregator.getStartedAt()!;

    const firstSend = new Date(start.getTime() + THIRTY_MIN_MS);
    aggregator.markProgressSent(firstSend);

    expect(
      aggregator.shouldSendProgress(new Date(firstSend.getTime() + THIRTY_MIN_MS - 1000)),
    ).toBe(false);
    expect(aggregator.shouldSendProgress(new Date(firstSend.getTime() + THIRTY_MIN_MS))).toBe(true);
  });

  it("should not reset the progress baseline on subsequent errors (no per-round reset)", () => {
    aggregator.recordError("HTTP_5XX");
    const start = aggregator.getStartedAt()!;

    // Many later errors must NOT push back the progress window.
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("TIMEOUT");

    expect(aggregator.shouldSendProgress(new Date(start.getTime() + THIRTY_MIN_MS))).toBe(true);
  });
});

// ── recover ────────────────────────────────────────────────────────────────

describe("recover", () => {
  it("should transition ALERTING → NORMAL", () => {
    aggregator.recordError("HTTP_5XX");
    expect(aggregator.getState()).toBe("ALERTING");

    aggregator.recover();
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should reset all counters", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("TIMEOUT");
    aggregator.recover();

    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getCategoryCounts().size).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("should clear all state back to initial", () => {
    aggregator.recordError("HTTP_5XX");
    aggregator.recordError("TIMEOUT");
    aggregator.markProgressSent(new Date());
    aggregator.reset();

    expect(aggregator.getState()).toBe("NORMAL");
    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getCategoryCounts().size).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
    expect(aggregator.shouldSendProgress(new Date())).toBe(false);
  });
});
