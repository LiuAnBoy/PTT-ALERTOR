import "./core/config";
import "./core/bigint";

import { app } from "./app";
import { config } from "./core/config";
import { createLogger } from "./core/logger";
import { connectDatabase, prisma } from "./core/prisma";
import { connectRedis, redis } from "./core/redis";
import { StartupLogger } from "./core/startupLogger";
import { crawlerWorker } from "./modules/board/workers/crawlerWorker";
import { dispatchWorker } from "./modules/board/workers/dispatchWorker";
import { maintenanceWorker } from "./modules/board/workers/maintenanceWorker";
import { startScheduler, stopScheduler } from "./modules/board/workers/scheduler";
import { updateWorker } from "./modules/board/workers/updateWorker";
import { notifierWorker } from "./modules/notification/workers/notifierWorker";
import { closeMatcherWorker } from "./modules/subscription/workers/matcherWorker";
import { startBot, stopBot } from "./modules/user/bot/bot";
import { syncSubscriptions } from "./modules/user/services/syncService";

const logger = createLogger("SERVER");

/**
 * Bootstrap the application.
 * Connect to database and Redis, start workers and scheduler,
 * then start the HTTP server.
 */
async function bootstrap() {
  StartupLogger.log();

  await connectDatabase();
  await connectRedis();
  await syncSubscriptions();
  await startScheduler();
  await startBot();

  logger.info(
    "Workers started: dispatchWorker, crawlerWorker, updateWorker, matcherWorker, notifierWorker",
  );

  const server = app.listen(config.port, () => {
    logger.info(`Server started on port ${config.port}`);
  });

  /**
   * Graceful shutdown handler.
   * Closes workers, scheduler, HTTP server, Redis, and Prisma in order.
   */
  async function shutdown(signal: string) {
    logger.info(`${signal} received, shutting down gracefully...`);

    await stopBot();
    await dispatchWorker.close();
    await crawlerWorker.close();
    await updateWorker.close();
    await maintenanceWorker.close();
    await closeMatcherWorker();
    await notifierWorker.close();
    logger.info("Workers stopped");

    await stopScheduler();

    server.close(async () => {
      await redis.quit();
      await prisma.$disconnect();
      logger.info("All connections closed");
      process.exit(0);
    });

    // Force exit after 10s if graceful shutdown fails
    setTimeout(() => {
      logger.error("Forced shutdown due to timeout");
      process.exit(1);
    }, 10_000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  logger.fatal(`Failed to start server: ${err.message}`);
  process.exit(1);
});
