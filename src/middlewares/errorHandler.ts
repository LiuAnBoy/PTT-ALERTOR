import type { NextFunction, Request, Response } from "express";

import { AppError } from "../core/errors/AppError";
import { createLogger } from "../core/logger";

const logger = createLogger("SERVER");

/**
 * Global error handling middleware.
 * Catches all errors and returns a standardized JSON response.
 */
export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    logger.error({ statusCode: err.statusCode }, err.message);
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
    return;
  }

  logger.error(err, "Unexpected error");
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
}
