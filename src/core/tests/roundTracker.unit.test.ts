jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { alertAggregator } from "../alertAggregator";
import { roundTracker } from "../roundTracker";

beforeEach(() => {
  roundTracker.reset();
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
});
