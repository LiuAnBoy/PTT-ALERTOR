import { randomBytes } from "node:crypto";

import type { buildMailConfig as BuildMailConfigFn } from "../config";

type BuildMailConfig = typeof BuildMailConfigFn;

// config.ts validates required vars at import time; give it placeholders when absent.
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildMailConfig } = require("../config") as { buildMailConfig: BuildMailConfig };

const key = randomBytes(32).toString("base64");

describe("buildMailConfig", () => {
  it("is disabled when either variable is missing", () => {
    expect(buildMailConfig({ PTT_ENCRYPT_KEY: key }).mail.enabled).toBe(false);
    expect(buildMailConfig({ TELEGRAM_WEBHOOK_SECRET: "abc" }).mail.enabled).toBe(false);
    expect(buildMailConfig({}).mail.enabled).toBe(false);
  });

  it("is enabled with both and defaults the daily limit to 20", () => {
    const { mail, webhookSecret } = buildMailConfig({
      PTT_ENCRYPT_KEY: key,
      TELEGRAM_WEBHOOK_SECRET: "a-B_9",
    });
    expect(mail).toEqual({ enabled: true, dailyLimit: 20, encryptKey: key });
    expect(webhookSecret).toBe("a-B_9");
  });

  it("reads MAIL_DAILY_LIMIT and rejects garbage", () => {
    expect(buildMailConfig({ MAIL_DAILY_LIMIT: "5" }).mail.dailyLimit).toBe(5);
    expect(() => buildMailConfig({ MAIL_DAILY_LIMIT: "0" })).toThrow(/MAIL_DAILY_LIMIT/);
    expect(() => buildMailConfig({ MAIL_DAILY_LIMIT: "x" })).toThrow(/MAIL_DAILY_LIMIT/);
  });

  it("throws on a webhook secret with an invalid character or over 256 chars", () => {
    expect(() => buildMailConfig({ TELEGRAM_WEBHOOK_SECRET: "bad secret" })).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
    expect(() => buildMailConfig({ TELEGRAM_WEBHOOK_SECRET: "a.b" })).toThrow();
    expect(() => buildMailConfig({ TELEGRAM_WEBHOOK_SECRET: "a".repeat(257) })).toThrow();
    expect(
      buildMailConfig({ TELEGRAM_WEBHOOK_SECRET: "a".repeat(256) }).webhookSecret,
    ).toHaveLength(256);
  });

  it("throws when the key is not 32 bytes after decoding", () => {
    expect(() => buildMailConfig({ PTT_ENCRYPT_KEY: randomBytes(16).toString("base64") })).toThrow(
      /PTT_ENCRYPT_KEY/,
    );
    expect(() => buildMailConfig({ PTT_ENCRYPT_KEY: randomBytes(33).toString("base64") })).toThrow(
      /PTT_ENCRYPT_KEY/,
    );
  });
});
