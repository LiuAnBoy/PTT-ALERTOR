import { alertAggregator } from "../../../core/alertAggregator";
import { classifyError } from "../../../core/errorClassifier";
import { getPrisma } from "../../../core/prisma";
import { isAdminRouteConfigured, sendAdminAlert } from "../../notification/services/adminNotifier";

/** Mirrors Prisma's LogLevel enum without requiring a generated client at compile time. */
type LogLevel = "WARN" | "ERROR" | "FATAL";

/**
 * Log an error to crawler_logs and optionally push alert to admin.
 * FATAL: always push immediately.
 * ERROR: records into AlertAggregator; only the first error triggers an immediate alert.
 *
 * @param level - Log severity level.
 * @param module - Module tag where the error occurred.
 * @param message - Error message summary.
 * @param detail - Optional error detail (stack trace, context, etc).
 */
export async function logError(
  level: LogLevel,
  module: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  // Write to database
  await getPrisma().crawlerLog.create({
    data: { level, module, message, detail: detail ?? undefined },
  });

  // Push alert to admin
  if (!isAdminRouteConfigured()) return;

  if (level === "FATAL") {
    await sendAdminAlert(`🚨 [FATAL] ${module} | ${message}`, "error");
  } else if (level === "ERROR") {
    const wasNormal = alertAggregator.getState() === "NORMAL";
    alertAggregator.recordError(classifyError(detail));

    if (wasNormal) {
      await sendAdminAlert(alertAggregator.getFirstAlert(), "error");
    }
  }
}

/**
 * Send a throttled progress alert while an outage is ongoing (at most every
 * 30 minutes). Marks the progress timestamp synchronously before awaiting the
 * send so concurrent callers in the same event loop cannot both pass the gate.
 */
export async function sendProgressAlert(): Promise<void> {
  const now = new Date();
  if (!alertAggregator.shouldSendProgress(now)) return;
  alertAggregator.markProgressSent(now);
  await sendAdminAlert(alertAggregator.getProgressAlert(), "warning");
}

/**
 * Send a recovery report and reset the aggregator back to NORMAL.
 * Should be called when the crawler recovers (circuit CLOSED while ALERTING).
 *
 * Order matters: build the report (reads counters) BEFORE recover() clears
 * them, and recover() synchronously flips state to NORMAL so a concurrent
 * caller cannot send a duplicate recovery notification.
 */
export async function sendRecoveryAlert(): Promise<void> {
  if (alertAggregator.getState() !== "ALERTING") return;
  const message = alertAggregator.getRecoveryMessage();
  alertAggregator.recover();
  await sendAdminAlert(message, "success");
}

/**
 * Get recent error logs from the last 24 hours.
 * @returns Array of crawler log records.
 */
export async function getRecentErrors() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return getPrisma().crawlerLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/**
 * Mark all unnotified errors as notified.
 * @returns Number of records updated.
 */
export async function clearErrors(): Promise<number> {
  const result = await getPrisma().crawlerLog.updateMany({
    where: { notified: false },
    data: { notified: true },
  });
  return result.count;
}
