import { alertAggregator } from "../../../core/alertAggregator";
import { classifyError } from "../../../core/errorClassifier";
import type { LostNotificationReport } from "../../../core/lostNotificationTracker";
import { lostNotifications } from "../../../core/lostNotificationTracker";
import { getPrisma } from "../../../core/prisma";
import { isAdminRouteConfigured, sendAdminAlert } from "../../notification/services/adminNotifier";

/** Mirrors Prisma's LogLevel enum without requiring a generated client at compile time. */
type LogLevel = "WARN" | "ERROR" | "FATAL";

/**
 * Log an error to crawler_logs and optionally push alert to admin.
 * FATAL: always push immediately.
 * ERROR: records into AlertAggregator; {@link closeAlertRound} decides when to alert.
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
    alertAggregator.recordError(classifyError(detail));
  }
}

/**
 * Close the current alert round and send whatever it calls for: the first alert, the recovery
 * report, or a throttled progress alert. Also sends lost notifications whose window has passed,
 * so a count is not hidden when no further loss follows. Called once per dispatch tick.
 * @param circuitClosed - Whether the circuit breaker is CLOSED.
 */
export async function closeAlertRound(circuitClosed: boolean): Promise<void> {
  const outcome = alertAggregator.closeRound(circuitClosed);
  if (outcome === "alert") {
    await sendAdminAlert(alertAggregator.getFirstAlert(), "error");
  } else if (outcome === "recover") {
    await sendRecoveryAlert();
  } else {
    await sendProgressAlert();
  }

  const lost = lostNotifications.takeDue(new Date());
  if (lost) await sendLostNotificationAlert(lost);
}

/**
 * Report a notification whose retries ran out, so it never reached the user. The first loss
 * alerts at once and later ones are throttled; see {@link lostNotifications}. The alert carries
 * the keyword and board only, never the raw error, which could quote a request or a token.
 * @param board - The article's board.
 * @param keyword - The matched keyword.
 */
export async function reportNotificationLost(board: string, keyword: string): Promise<void> {
  const target = `${keyword}@${board}`;
  const due = lostNotifications.record(target, new Date());
  if (due) await sendLostNotificationAlert(due);
  await logError("ERROR", "NOTIFIER", `Notification lost: ${target}`);
}

/**
 * Send one lost-notification alert.
 * @param report - The losses to report.
 */
async function sendLostNotificationAlert(report: LostNotificationReport): Promise<void> {
  const detail =
    report.count === 1
      ? `重試用盡，沒有送出：${report.latest}`
      : `重試用盡，共 ${report.count} 則沒有送出，最後一則：${report.latest}`;
  await sendAdminAlert(`⚠️ 推播通知遺失\n${detail}`, "error");
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
 * Called when a round's outcome is "recover".
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
