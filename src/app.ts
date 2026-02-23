import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { baseLogger } from "./core/logger";
import { errorMiddleware } from "./middlewares/errorHandler";
import { getWebhookHandler, getWebhookPath } from "./modules/broadcast/channels/telegram";

const app = express();

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env["ALLOWED_ORIGINS"]?.split(",") ?? false,
  }),
);
app.use(express.json());
app.use(pinoHttp({ logger: baseLogger, autoLogging: { ignore: (req) => req.url === "/health" } }));

// Health check (GET — return data directly)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Telegram webhook
app.post(getWebhookPath(), getWebhookHandler());

// Error handler (must be last)
app.use(errorMiddleware);

export { app };
