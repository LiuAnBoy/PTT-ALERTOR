import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * Parse REDIS_DB env var as a strict non-negative integer (0-15).
 * Returns 0 when unset; throws on garbage input so we never silently
 * fall back to db0 and accidentally flush another service's database.
 */
function parseRedisDb(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 15) {
    throw new Error(`Invalid REDIS_DB="${raw}": must be a non-negative integer between 0 and 15.`);
  }
  return n;
}

/**
 * Centralized application configuration.
 * Reads from process.env once at module load time (after dotenv).
 * All other modules should import from here instead of reading process.env directly.
 */
export const config = {
  /** Node environment (defaults to "production" if not set) */
  nodeEnv: process.env["NODE_ENV"] ?? "production",
  /** Whether running in production */
  isProduction: (process.env["NODE_ENV"] ?? "production") === "production",

  /** HTTP server port */
  port: Number(process.env["PORT"]) || 8000,

  /** PostgreSQL connection */
  postgres: {
    user: process.env["POSTGRES_USER"] ?? "",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    host: process.env["POSTGRES_HOST"] ?? "",
    port: Number(process.env["POSTGRES_PORT"]) || 5432,
    database: process.env["POSTGRES_DATABASE"] ?? "",
    poolSize: Number(process.env["POSTGRES_POOL_SIZE"]) || 10,
    get url(): string {
      return `postgresql://${config.postgres.user}:${config.postgres.password}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`;
    },
  },

  /** Redis connection */
  redis: {
    host: process.env["REDIS_HOST"] ?? "",
    port: Number(process.env["REDIS_PORT"]) || 6379,
    db: parseRedisDb(process.env["REDIS_DB"]),
  },

  /** Telegram bot */
  telegram: {
    token: process.env["TELEGRAM_TOKEN"] ?? "",
    botUsername: process.env["TELEGRAM_BOT_USERNAME"] ?? "",
    webhookUrl: process.env["TELEGRAM_WEBHOOK_URL"] ?? "",
    /** Fill in your Telegram chat ID to receive FATAL/ERROR alerts */
    adminChatId: process.env["ADMIN_TELEGRAM_ID"] ?? "",
  },
} as const;

// ── Validate required environment variables on module load ──────────────────

const required: { key: string; value: string }[] = [
  { key: "POSTGRES_USER", value: config.postgres.user },
  { key: "POSTGRES_PASSWORD", value: config.postgres.password },
  { key: "POSTGRES_HOST", value: config.postgres.host },
  { key: "POSTGRES_DATABASE", value: config.postgres.database },
  { key: "REDIS_HOST", value: config.redis.host },
  { key: "TELEGRAM_TOKEN", value: config.telegram.token },
  { key: "TELEGRAM_BOT_USERNAME", value: config.telegram.botUsername },
  { key: "TELEGRAM_WEBHOOK_URL", value: config.telegram.webhookUrl },
];

const missing = required.filter((r) => !r.value).map((r) => r.key);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
