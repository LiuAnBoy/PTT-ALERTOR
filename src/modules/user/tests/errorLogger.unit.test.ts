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
  config: {
    telegram: { adminChatId: "12345" },
    notify: {
      url: "http://127.0.0.1:5000",
      serviceKey: "",
      adminChannel: "system_admin",
      enabled: false,
    },
  },
}));

import { alertAggregator } from "../../../core/alertAggregator";
import { config } from "../../../core/config";
import { logError, sendProgressAlert, sendRecoveryAlert } from "../services/errorLogger";

const THIRTY_MIN_MS = 30 * 60_000;

type MutableConfig = {
  telegram: { adminChatId: string };
  notify: { serviceKey: string; enabled: boolean };
};
const cfg = config as unknown as MutableConfig;
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  alertAggregator.reset();
  cfg.telegram.adminChatId = "12345";
  cfg.notify.serviceKey = "";
  cfg.notify.enabled = false;
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
});

/** Parse the JSON body of the n-th Service Manager call. */
function smBody(n = 0): { params: { text: string }; level: string } {
  return JSON.parse(fetchMock.mock.calls[n][1].body);
}

describe("logError", () => {
  it("sends first alert immediately when state transitions from NORMAL to ALERTING", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("爬蟲異常"));
    expect(alertAggregator.getState()).toBe("ALERTING");
  });

  it("classifies the error from its detail (502 → HTTP_5XX)", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });

    expect(alertAggregator.getCategoryCounts().get("HTTP_5XX")).toBe(1);
  });

  it("does NOT send additional alerts for subsequent ERRORs while ALERTING", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();

    await logError("ERROR", "CRAWLER", "another failure", { httpStatus: 502 });
    await logError("ERROR", "DETAIL", "detail timeout", { errorMsg: "ETIMEDOUT" });

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(alertAggregator.getTotalErrors()).toBe(3);
  });

  it("always sends FATAL alerts immediately regardless of state", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();

    await logError("FATAL", "CRAWLER", "process crashed");

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("[FATAL]"));
  });
});

describe("sendProgressAlert", () => {
  it("does nothing when state is NORMAL", async () => {
    await sendProgressAlert();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("does nothing before 30 minutes have elapsed", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();

    await sendProgressAlert();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("sends a throttled progress alert once 30 minutes have elapsed", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();

    // Backdate the throttle baseline so the 30-minute window has elapsed.
    alertAggregator.markProgressSent(new Date(Date.now() - THIRTY_MIN_MS - 1000));

    await sendProgressAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("爬蟲持續異常中"));
  });

  it("marks progress synchronously so a concurrent call does not double-send", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();
    alertAggregator.markProgressSent(new Date(Date.now() - THIRTY_MIN_MS - 1000));

    await Promise.all([sendProgressAlert(), sendProgressAlert()]);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });
});

describe("sendRecoveryAlert", () => {
  it("sends recovery report and resets state to NORMAL", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();

    await sendRecoveryAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("恢復正常"));
    expect(alertAggregator.getState()).toBe("NORMAL");
  });

  it("builds the report BEFORE clearing counters (non-empty breakdown)", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    mockSendAlert.mockClear();

    await sendRecoveryAlert();

    const [, message] = mockSendAlert.mock.calls[0];
    expect(message).toContain("累計錯誤：2 次");
    expect(message).toContain("PTT 伺服器錯誤(5xx)：2 次");
  });

  it("does nothing when state is NORMAL (guards against duplicate sends)", async () => {
    await sendRecoveryAlert();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe("Service Manager route", () => {
  beforeEach(() => {
    cfg.notify.serviceKey = "k";
    cfg.notify.enabled = true;
  });

  it("sends the first alert and FATAL as error, progress as warning, recovery as success", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    expect(smBody(0).level).toBe("error");
    expect(smBody(0).params.text).toContain("爬蟲異常");

    await logError("FATAL", "CRAWLER", "crashed");
    expect(smBody(1).level).toBe("error");
    expect(smBody(1).params.text).toBe("[FATAL] CRAWLER | crashed");

    alertAggregator.markProgressSent(new Date(Date.now() - THIRTY_MIN_MS - 1000));
    await sendProgressAlert();
    expect(smBody(2).level).toBe("warning");

    await sendRecoveryAlert();
    expect(smBody(3).level).toBe("success");
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("still alerts when ADMIN_TELEGRAM_ID is empty", async () => {
    cfg.telegram.adminChatId = "";
    await logError("FATAL", "CRAWLER", "crashed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the admin chat when Service Manager fails", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await logError("FATAL", "CRAWLER", "crashed");
    expect(mockSendAlert).toHaveBeenCalledWith("12345", "🚨 [FATAL] CRAWLER | crashed");
  });
});

describe("no route configured", () => {
  it("sends nothing when both routes are unset", async () => {
    cfg.telegram.adminChatId = "";
    await logError("FATAL", "CRAWLER", "crashed");
    await logError("ERROR", "CRAWLER", "x", { httpStatus: 502 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});
