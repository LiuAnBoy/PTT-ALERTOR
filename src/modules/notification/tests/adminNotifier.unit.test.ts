/**
 * Unit tests for adminNotifier.
 *
 * Covers the exact Service Manager call, route choice, fallback to the direct Telegram chat,
 * and that the service key never reaches a log call.
 */

const CANARY = "canary-secret-key-9f3a";

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock("../../../core/logger", () => ({ createLogger: () => mockLogger }));

const mockSendAlert = jest.fn();
jest.mock("../../broadcast/registry", () => ({
  getAdapter: () => ({ sendAlert: mockSendAlert }),
}));

jest.mock("../../../core/config", () => {
  // Build config.notify through the real builder so env names and defaults are covered.
  const placeholders: Record<string, string> = {
    POSTGRES_USER: "u",
    POSTGRES_PASSWORD: "p",
    POSTGRES_HOST: "h",
    POSTGRES_DATABASE: "d",
    REDIS_HOST: "h",
    TELEGRAM_TOKEN: "t",
    TELEGRAM_BOT_USERNAME: "b",
    TELEGRAM_WEBHOOK_URL: "https://example.com",
  };
  for (const [k, v] of Object.entries(placeholders)) process.env[k] ??= v;
  const actual = jest.requireActual<typeof ConfigModule>("../../../core/config");
  return {
    ...actual,
    config: {
      telegram: { adminChatId: "12345" },
      notify: actual.buildNotifyConfig({ SERVICE_KEY: "canary-secret-key-9f3a" }),
    },
  };
});

import { alertAggregator } from "../../../core/alertAggregator";
import type * as ConfigModule from "../../../core/config";
import { buildNotifyConfig, config } from "../../../core/config";
import { isAdminRouteConfigured, sendAdminAlert } from "../services/adminNotifier";

type MutableConfig = {
  telegram: { adminChatId: string };
  notify: ReturnType<typeof buildNotifyConfig>;
};
const cfg = config as unknown as MutableConfig;
const fetchMock = jest.fn();

function envelope(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function allLogged(): string {
  return JSON.stringify(
    [mockLogger.debug, mockLogger.info, mockLogger.warn, mockLogger.error].map((m) => m.mock.calls),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendAlert.mockResolvedValue(undefined);
  cfg.telegram.adminChatId = "12345";
  cfg.notify = buildNotifyConfig({ SERVICE_KEY: CANARY });
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async () => envelope(200, { success: true, payload: {} }));
});

describe("Service Manager route", () => {
  it("posts the exact request and does not fall back after delivery", async () => {
    await sendAdminAlert("🚨 [FATAL] CRAWLER | boom", "error");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5000/v1/notify/telegram");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${CANARY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      channel: "system_admin",
      method: "sendMessage",
      params: { text: "[FATAL] CRAWLER | boom", parse_mode: "none" },
      level: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it("strips the first alert's emoji and variation selector completely", async () => {
    alertAggregator.reset();
    alertAggregator.recordError("OTHER");
    const text = alertAggregator.getFirstAlert();
    expect(text.startsWith("⚠️")).toBe(true);

    await sendAdminAlert(text, "error");

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).params.text as string;
    expect(sent).toBe(text.replace("⚠️ ", ""));
    expect(sent.startsWith("爬蟲異常偵測\n")).toBe(true);
    expect(sent).not.toContain("️");
  });

  it.each(["warning", "success"] as const)("passes level %s through", async (level) => {
    await sendAdminAlert("⏳ 爬蟲持續異常中", level);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).level).toBe(level);
  });

  it("uses the configured URL and channel", async () => {
    cfg.notify = buildNotifyConfig({
      SERVICE_KEY: CANARY,
      NOTIFY_SERVICE_URL: "http://notify:9000/",
      NOTIFY_ADMIN_CHANNEL: "ops",
    });
    await sendAdminAlert("x", "warning");
    expect(fetchMock.mock.calls[0][0]).toBe("http://notify:9000/v1/notify/telegram");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).channel).toBe("ops");
  });
});

describe("direct route", () => {
  it("sends the unchanged text to the admin chat when no key is set", async () => {
    cfg.notify = buildNotifyConfig({});
    await sendAdminAlert("🚨 [FATAL] X | y", "error");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledWith("12345", "🚨 [FATAL] X | y");
  });

  it("does nothing and does not throw when neither route is configured", async () => {
    cfg.notify = buildNotifyConfig({});
    cfg.telegram.adminChatId = "";
    await expect(sendAdminAlert("x", "error")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe("fallback to the direct chat", () => {
  const cases: [string, () => void][] = [
    [
      "non-2xx",
      () => fetchMock.mockResolvedValue(envelope(502, { success: false, payload: { code: "x" } })),
    ],
    [
      "2xx with success false",
      () =>
        fetchMock.mockResolvedValue(envelope(200, { success: false, payload: { code: "denied" } })),
    ],
    [
      "non-2xx with success true",
      () => fetchMock.mockResolvedValue(envelope(500, { success: true })),
    ],
    ["unparseable body", () => fetchMock.mockResolvedValue(envelope(200, "<html>"))],
    ["network error", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
    ["timeout", () => fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"))],
  ];

  it.each(cases)("falls back on %s with the original text", async (_name, arrange) => {
    arrange();
    await sendAdminAlert("🚨 [FATAL] X | y", "error");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith("12345", "🚨 [FATAL] X | y");
  });

  it("logs the status and payload code only", async () => {
    fetchMock.mockResolvedValue(envelope(403, { success: false, payload: { code: "forbidden" } }));
    await sendAdminAlert("x", "error");
    expect(allLogged()).toContain("status=403 code=forbidden");
  });

  it("logs an unrecognised payload code instead of the server-supplied text", async () => {
    fetchMock.mockResolvedValue(envelope(400, { success: false, payload: { code: CANARY } }));
    await sendAdminAlert("x", "error");
    expect(allLogged()).not.toContain(CANARY);
    expect(allLogged()).toContain("status=400 code=unrecognised");
  });

  it("never throws, even when both routes fail", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    mockSendAlert.mockRejectedValue(new Error("telegram down"));
    await expect(sendAdminAlert("x", "error")).resolves.toBeUndefined();
  });

  it("never throws when the key-less fallback also fails", async () => {
    cfg.notify = buildNotifyConfig({});
    mockSendAlert.mockRejectedValue(new Error("telegram down"));
    await expect(sendAdminAlert("x", "error")).resolves.toBeUndefined();
  });
});

describe("secret handling", () => {
  it("keeps the key out of every log call when the rejected error carries it", async () => {
    fetchMock.mockRejectedValue(new Error(`connect failed, Authorization: Bearer ${CANARY}`));
    await sendAdminAlert("x", "error");
    expect(allLogged()).not.toContain(CANARY);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe("isAdminRouteConfigured", () => {
  it("is true when either route is set and false when neither is", () => {
    expect(isAdminRouteConfigured()).toBe(true);
    cfg.telegram.adminChatId = "";
    expect(isAdminRouteConfigured()).toBe(true);
    cfg.notify = buildNotifyConfig({});
    expect(isAdminRouteConfigured()).toBe(false);
    cfg.telegram.adminChatId = "1";
    expect(isAdminRouteConfigured()).toBe(true);
  });
});
