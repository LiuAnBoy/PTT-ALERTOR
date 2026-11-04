import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { baseLogger } from "./core/logger";
import { errorMiddleware } from "./middlewares/errorHandler";
import { getWebhookHandler, getWebhookPath } from "./modules/broadcast/channels/telegram";

const app: Express = express();

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env["ALLOWED_ORIGINS"]?.split(",") ?? false,
  }),
);
app.use(express.json());
// Request logs carry only id, method and path: never headers (the webhook secret travels in one)
// and never the body (Telegram updates hold message text, PTT passwords included).
app.use(
  pinoHttp({
    logger: baseLogger,
    autoLogging: { ignore: (req) => req.url === "/health" },
    serializers: {
      req: (req: { id?: unknown; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
    },
  }),
);

// Health check (GET — return data directly)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Telegram webhook
app.post(getWebhookPath(), getWebhookHandler());

// Error handler (must be last)
app.use(errorMiddleware);

export { app };
