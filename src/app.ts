import cors from "cors";
import express from "express";
import helmet from "helmet";

import { errorMiddleware } from "./middlewares/errorHandler";
import { getWebhookHandler, getWebhookPath } from "./modules/broadcast/channels/telegram";

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check (GET — return data directly)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Telegram webhook
app.post(getWebhookPath(), getWebhookHandler());

// Error handler (must be last)
app.use(errorMiddleware);

export { app };
