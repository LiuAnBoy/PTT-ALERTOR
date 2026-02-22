import { config } from "./config";
import { createLogger } from "./logger";

const logger = createLogger("CONFIG");

/**
 * Logs application configuration at startup for debugging and verification.
 */
export class StartupLogger {
  /**
   * Log all startup configuration details.
   * Masks sensitive values like passwords and tokens.
   */
  static log(): void {
    logger.info("=== Application Configuration ===");
    logger.info(`Environment : ${config.nodeEnv}`);
    logger.info(`Port        : ${config.port}`);

    logger.info("--- PostgreSQL ---");
    logger.info(`Host     : ${config.postgres.host}:${config.postgres.port}`);
    logger.info(`Database : ${config.postgres.database}`);
    logger.info(`User     : ${config.postgres.user}`);

    logger.info("--- Redis ---");
    logger.info(`Host : ${config.redis.host}:${config.redis.port}`);

    logger.info("--- Telegram ---");
    logger.info(`Bot Username : ${config.telegram.botUsername || "(not set)"}`);
    logger.info(`Token        : ${StartupLogger.maskToken(config.telegram.token)}`);
    logger.info(`Webhook URL  : ${config.telegram.webhookUrl || "(not set)"}`);
    logger.info(`Admin Chat   : ${config.telegram.adminChatId || "(not set)"}`);

    logger.info("=================================");
  }

  /**
   * Mask a token string, showing only the first 4 and last 4 characters.
   * @param token - The token to mask.
   * @returns Masked token string.
   */
  private static maskToken(token: string): string {
    if (!token) return "(not set)";
    if (token.length <= 8) return "****";
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }
}
