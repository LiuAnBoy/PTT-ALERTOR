import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * Centralized application configuration.
 * Reads from process.env once at module load time (after dotenv).
 * All other modules should import from here instead of reading process.env directly.
 */
export const config = {
  /** Node environment */
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  /** Whether running in production */
  isProduction: process.env["NODE_ENV"] === "production",

  /** HTTP server port */
  port: Number(process.env["PORT"]) || 8000,

  /** PostgreSQL connection */
  postgres: {
    user: process.env["POSTGRES_USER"] ?? "admin",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    host: process.env["POSTGRES_HOST"] ?? "localhost",
    port: Number(process.env["POSTGRES_PORT"]) || 5432,
    database: process.env["POSTGRES_DATABASE"] ?? "ptt-alert",
    get url(): string {
      return (
        process.env["DATABASE_URL"] ??
        `postgresql://${config.postgres.user}:${config.postgres.password}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`
      );
    },
  },

  /** Redis connection */
  redis: {
    host: process.env["REDIS_HOST"] ?? "localhost",
    port: Number(process.env["REDIS_PORT"]) || 6379,
  },

  /** Telegram bot */
  telegram: {
    token: process.env["TELEGRAM_TOKEN"] ?? "",
    botUsername: process.env["TELEGRAM_BOT_USERNAME"] ?? "",
    adminChatId: process.env["ADMIN_TELEGRAM_ID"] ?? "",
    webhookUrl: process.env["TELEGRAM_WEBHOOK_URL"] ?? "",
    webhookSecret: process.env["TELEGRAM_WEBHOOK_SECRET"] ?? "",
  },
} as const;
