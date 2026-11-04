/**
 * Unit tests for StartupLogger's admin alert route line: it must name the route that is
 * actually active and never print the service key.
 */

const mockInfo = jest.fn();
jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: mockInfo, warn: jest.fn(), error: jest.fn() }),
}));

const KEY = "canary-startup-key-71c2";

const mockConfig = {
  nodeEnv: "test",
  port: 9090,
  postgres: { host: "h", port: 5432, database: "d", user: "u" },
  redis: { host: "h", port: 6379 },
  telegram: { botUsername: "b", token: "token-1234567890", webhookUrl: "", adminChatId: "" },
  notify: { enabled: false, serviceKey: "", adminChannel: "system_admin", url: "" },
};
jest.mock("../config", () => ({ config: mockConfig }));

import { StartupLogger } from "../startupLogger";

/**
 * Run the startup log with the given routes and return the admin route line.
 * @param serviceKey - SERVICE_KEY value, empty for none.
 * @param adminChatId - ADMIN_TELEGRAM_ID value, empty for none.
 * @returns The logged "Route : ..." line.
 */
function routeLine(serviceKey: string, adminChatId: string): string {
  mockInfo.mockClear();
  mockConfig.notify = { ...mockConfig.notify, serviceKey, enabled: serviceKey !== "" };
  mockConfig.telegram = { ...mockConfig.telegram, adminChatId };
  StartupLogger.log();
  const lines = mockInfo.mock.calls.map((c) => String(c[0]));
  expect(lines.join("\n")).not.toContain(KEY);
  return lines.find((l) => l.startsWith("Route :")) ?? "";
}

describe("StartupLogger admin route line", () => {
  it.each([
    [KEY, "123", "Route : Service Manager (channel system_admin), fallback to Admin Chat"],
    [KEY, "", "Route : Service Manager (channel system_admin), no fallback (Admin Chat not set)"],
    ["", "123", "Route : Admin Chat (direct Telegram)"],
    ["", "", "Route : none (alerts are only written to the database)"],
  ])("key %j, admin chat %j → %s", (key, chat, expected) => {
    expect(routeLine(key, chat)).toBe(expected);
  });
});
