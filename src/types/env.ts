/**
 * Environment variable definitions.
 */
export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;

  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_DATABASE: string;

  REDIS_PORT: number;

  TELEGRAM_TOKEN: string;
  TELEGRAM_BOT_USERNAME?: string;
  ADMIN_TELEGRAM_ID?: string;
}
