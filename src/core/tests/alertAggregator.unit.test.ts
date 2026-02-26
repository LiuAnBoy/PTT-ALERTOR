jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { AlertAggregator } from "../alertAggregator";

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
    aggregator.recordError("htmlFetcher", "connection timeout");
    expect(aggregator.getState()).toBe("ALERTING");
  });

  it("should remain in ALERTING on subsequent errors", () => {
    aggregator.recordError("htmlFetcher", "timeout");
    aggregator.recordError("detailFetcher", "404");
    expect(aggregator.getState()).toBe("ALERTING");
  });
});

// ── Error accumulation ─────────────────────────────────────────────────────

describe("error accumulation", () => {
  it("should count errors per module", () => {
    aggregator.recordError("htmlFetcher", "timeout");
    aggregator.recordError("htmlFetcher", "timeout again");
    aggregator.recordError("detailFetcher", "404");

    const counts = aggregator.getErrorCounts();
    expect(counts.get("htmlFetcher")).toBe(2);
    expect(counts.get("detailFetcher")).toBe(1);
  });

  it("should track total errors", () => {
    aggregator.recordError("htmlFetcher", "err1");
    aggregator.recordError("htmlFetcher", "err2");
    aggregator.recordError("detailFetcher", "err3");

    expect(aggregator.getTotalErrors()).toBe(3);
  });

  it("should return a copy of error counts (not the internal map)", () => {
    aggregator.recordError("htmlFetcher", "err");
    const counts = aggregator.getErrorCounts();
    counts.set("htmlFetcher", 999);

    expect(aggregator.getErrorCounts().get("htmlFetcher")).toBe(1);
  });
});

// ── startedAt tracking ─────────────────────────────────────────────────────

describe("startedAt tracking", () => {
  it("should be null in NORMAL state", () => {
    expect(aggregator.getStartedAt()).toBeNull();
  });

  it("should be set when entering ALERTING state", () => {
    const before = new Date();
    aggregator.recordError("htmlFetcher", "error");
    const after = new Date();

    const startedAt = aggregator.getStartedAt();
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(startedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should keep the original startedAt on subsequent errors", () => {
    aggregator.recordError("htmlFetcher", "first");
    const first = aggregator.getStartedAt();

    aggregator.recordError("htmlFetcher", "second");
    expect(aggregator.getStartedAt()).toBe(first);
  });
});

// ── getFirstAlert ──────────────────────────────────────────────────────────

describe("getFirstAlert", () => {
  it('should contain "爬蟲異常"', () => {
    aggregator.recordError("htmlFetcher", "timeout");
    const alert = aggregator.getFirstAlert();
    expect(alert).toContain("爬蟲異常");
  });

  it("should include the timestamp", () => {
    aggregator.recordError("htmlFetcher", "timeout");
    const alert = aggregator.getFirstAlert();
    const startedAt = aggregator.getStartedAt();
    expect(alert).toContain(startedAt!.toISOString());
  });
});

// ── getSummary ─────────────────────────────────────────────────────────────

describe("getSummary", () => {
  it("should list per-module error counts", () => {
    aggregator.recordError("htmlFetcher", "err");
    aggregator.recordError("htmlFetcher", "err");
    aggregator.recordError("detailFetcher", "err");

    const summary = aggregator.getSummary();
    expect(summary).toContain("htmlFetcher: 2");
    expect(summary).toContain("detailFetcher: 1");
  });

  it("should include the total count", () => {
    aggregator.recordError("htmlFetcher", "err");
    aggregator.recordError("detailFetcher", "err");

    const summary = aggregator.getSummary();
    expect(summary).toContain("總計: 2");
  });
});

// ── getRecoveryMessage ─────────────────────────────────────────────────────

describe("getRecoveryMessage", () => {
  it('should contain "恢復正常"', () => {
    aggregator.recordError("htmlFetcher", "err");
    const msg = aggregator.getRecoveryMessage();
    expect(msg).toContain("恢復正常");
  });

  it("should include duration and total errors", () => {
    aggregator.recordError("htmlFetcher", "err");
    aggregator.recordError("htmlFetcher", "err2");

    const msg = aggregator.getRecoveryMessage();
    expect(msg).toContain("持續時間:");
    expect(msg).toContain("分鐘");
    expect(msg).toContain("累計錯誤: 2");
  });
});

// ── recover ────────────────────────────────────────────────────────────────

describe("recover", () => {
  it("should transition ALERTING → NORMAL", () => {
    aggregator.recordError("htmlFetcher", "err");
    expect(aggregator.getState()).toBe("ALERTING");

    aggregator.recover();
    expect(aggregator.getState()).toBe("NORMAL");
  });

  it("should reset all counters", () => {
    aggregator.recordError("htmlFetcher", "err");
    aggregator.recordError("detailFetcher", "err");
    aggregator.recover();

    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getErrorCounts().size).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("should clear all state back to initial", () => {
    aggregator.recordError("htmlFetcher", "err");
    aggregator.recordError("detailFetcher", "err");
    aggregator.reset();

    expect(aggregator.getState()).toBe("NORMAL");
    expect(aggregator.getTotalErrors()).toBe(0);
    expect(aggregator.getErrorCounts().size).toBe(0);
    expect(aggregator.getStartedAt()).toBeNull();
  });
});
