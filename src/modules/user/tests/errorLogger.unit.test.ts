jest.mock("../../../core/logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock("../../../core/prisma", () => ({
  getPrisma: () => ({ crawlerLog: { create: jest.fn().mockResolvedValue({}) } }),
}));
const mockSendAlert = jest.fn().mockResolvedValue(undefined);
jest.mock("../../broadcast/registry", () => ({
  getAdapter: () => ({ sendAlert: mockSendAlert }),
}));
jest.mock("../../../core/config", () => ({
  config: { telegram: { adminChatId: "12345" } },
}));

import { alertAggregator } from "../../../core/alertAggregator";
import { logError, sendRecoveryAlert, sendSummaryAlert } from "../services/errorLogger";

beforeEach(() => {
  jest.clearAllMocks();
  alertAggregator.reset();
});

describe("logError", () => {
  it("sends first alert immediately when state transitions from NORMAL to ALERTING", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed");

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("爬蟲異常"));
    expect(alertAggregator.getState()).toBe("ALERTING");
  });

  it("does NOT send additional alerts for subsequent ERRORs while ALERTING", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed");
    mockSendAlert.mockClear();

    await logError("ERROR", "CRAWLER", "another failure");
    await logError("ERROR", "DETAIL", "detail timeout");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(alertAggregator.getTotalErrors()).toBe(3);
  });

  it("always sends FATAL alerts immediately regardless of state", async () => {
    // Put into ALERTING state first
    await logError("ERROR", "CRAWLER", "fetch failed");
    mockSendAlert.mockClear();

    await logError("FATAL", "CRAWLER", "process crashed");

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("[FATAL]"));
  });
});

describe("sendSummaryAlert", () => {
  it("sends summary when state is ALERTING", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed");
    await logError("ERROR", "DETAIL", "detail timeout");
    mockSendAlert.mockClear();

    await sendSummaryAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("錯誤統計摘要"));
  });

  it("does nothing when state is NORMAL", async () => {
    await sendSummaryAlert();

    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe("sendRecoveryAlert", () => {
  it("sends recovery message and resets state to NORMAL", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed");
    mockSendAlert.mockClear();

    await sendRecoveryAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("恢復正常"));
    expect(alertAggregator.getState()).toBe("NORMAL");
  });
});
