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
import { lostNotifications } from "../../../core/lostNotificationTracker";
import {
  closeAlertRound,
  logError,
  reportNotificationLost,
  sendProgressAlert,
  sendRecoveryAlert,
} from "../services/errorLogger";

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
  lostNotifications.reset();
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

/**
 * Run `count` rounds that each log one ERROR.
 * @param count - Number of rounds.
 */
async function failRounds(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });
    await closeAlertRound(true);
  }
}

describe("logError", () => {
  it("sends nothing for an ERROR by itself", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(alertAggregator.getState()).toBe("NORMAL");
  });

  it("classifies the error from its detail (502 → HTTP_5XX)", async () => {
    await logError("ERROR", "CRAWLER", "fetch failed", { httpStatus: 502 });

    expect(alertAggregator.getCategoryCounts().get("HTTP_5XX")).toBe(1);
  });

  it("always sends FATAL alerts immediately, with no failing rounds", async () => {
    await logError("FATAL", "CRAWLER", "process crashed");

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("[FATAL]"));
  });
});

describe("closeAlertRound", () => {
  it("sends one first alert on the fifth consecutive failing round", async () => {
    await failRounds(4);
    expect(mockSendAlert).not.toHaveBeenCalled();

    await failRounds(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("爬蟲異常"));

    await failRounds(3);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for errors that clear before the fifth round", async () => {
    await failRounds(4);
    await closeAlertRound(true);
    await failRounds(4);

    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("sends one recovery report after three clean rounds", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();

    await closeAlertRound(true);
    await closeAlertRound(true);
    expect(mockSendAlert).not.toHaveBeenCalled();

    await closeAlertRound(true);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("恢復正常"));
    expect(alertAggregator.getState()).toBe("NORMAL");

    await closeAlertRound(true);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it("sends a due progress alert while the outage goes on", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();
    alertAggregator.markProgressSent(new Date(Date.now() - THIRTY_MIN_MS - 1000));

    await failRounds(1);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("爬蟲持續異常中"));
  });
});

describe("reportNotificationLost", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("alerts at once with the keyword and board", async () => {
    await reportNotificationLost("Soho", "react");

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    const [, message] = mockSendAlert.mock.calls[0];
    expect(message).toContain("推播通知遺失");
    expect(message).toContain("react@Soho");
  });

  it("does not alert again inside the window", async () => {
    await reportNotificationLost("Soho", "react");
    await reportNotificationLost("Soho", "vue");

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it("sends accumulated losses from the round close once the window has passed", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-04T00:00:00Z") });
    await reportNotificationLost("Soho", "react");
    await reportNotificationLost("Soho", "vue");
    await reportNotificationLost("CodeJob", "node");
    mockSendAlert.mockClear();

    await closeAlertRound(true);
    expect(mockSendAlert).not.toHaveBeenCalled();

    jest.setSystemTime(new Date("2026-11-04T00:30:00Z"));
    await closeAlertRound(true);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    const [, message] = mockSendAlert.mock.calls[0];
    expect(message).toContain("共 2 則");
    expect(message).toContain("node@CodeJob");

    await closeAlertRound(true);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it("alerts through Service Manager without the leading emoji", async () => {
    cfg.notify.serviceKey = "k";
    cfg.notify.enabled = true;

    await reportNotificationLost("Soho", "react");

    expect(smBody().level).toBe("error");
    expect(smBody().params.text.startsWith("推播通知遺失\n")).toBe(true);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe("sendProgressAlert", () => {
  it("does nothing when state is NORMAL", async () => {
    await sendProgressAlert();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("does nothing before 30 minutes have elapsed", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();

    await sendProgressAlert();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("sends a throttled progress alert once 30 minutes have elapsed", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();

    // Backdate the throttle baseline so the 30-minute window has elapsed.
    alertAggregator.markProgressSent(new Date(Date.now() - THIRTY_MIN_MS - 1000));

    await sendProgressAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("爬蟲持續異常中"));
  });

  it("marks progress synchronously so a concurrent call does not double-send", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();
    alertAggregator.markProgressSent(new Date(Date.now() - THIRTY_MIN_MS - 1000));

    await Promise.all([sendProgressAlert(), sendProgressAlert()]);

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });
});

describe("sendRecoveryAlert", () => {
  it("sends recovery report and resets state to NORMAL", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();

    await sendRecoveryAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", expect.stringContaining("恢復正常"));
    expect(alertAggregator.getState()).toBe("NORMAL");
  });

  it("builds the report BEFORE clearing counters (non-empty breakdown)", async () => {
    await failRounds(5);
    mockSendAlert.mockClear();

    await sendRecoveryAlert();

    const [, message] = mockSendAlert.mock.calls[0];
    expect(message).toContain("累計錯誤：5 次");
    expect(message).toContain("PTT 伺服器錯誤(5xx)：5 次");
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
    await failRounds(5);
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
    await failRounds(5);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});
