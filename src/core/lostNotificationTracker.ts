/** Minimum gap between two lost-notification alerts. */
const ALERT_INTERVAL_MS = 30 * 60_000;

/** The losses an alert has to report. */
export interface LostNotificationReport {
  /** Notifications lost since the last alert. */
  count: number;
  /** The most recently lost notification, as keyword@board. */
  latest: string;
}

/**
 * Throttles lost-notification alerts: when Telegram is down every notification fails, so the first
 * loss alerts at once and later ones accumulate until the 30-minute window has passed.
 *
 * NOTE: state is process-local, like AlertAggregator, and restarts empty.
 */
export class LostNotificationTracker {
  private pending = 0;
  private latest = "";
  private lastAlertAt: Date | null = null;

  /**
   * Record one lost notification.
   * @param target - The lost notification, as keyword@board.
   * @param now - The current time.
   * @returns The report to send now, or null while the window is still open.
   */
  record(target: string, now: Date): LostNotificationReport | null {
    this.pending += 1;
    this.latest = target;
    return this.takeDue(now);
  }

  /**
   * Take the accumulated losses when an alert is due. Marks the alert as sent synchronously, so
   * a concurrent caller cannot report the same losses twice.
   * @param now - The current time.
   * @returns The report to send now, or null when nothing is pending or the window is still open.
   */
  takeDue(now: Date): LostNotificationReport | null {
    if (this.pending === 0) return null;
    if (
      this.lastAlertAt !== null &&
      now.getTime() - this.lastAlertAt.getTime() < ALERT_INTERVAL_MS
    ) {
      return null;
    }
    const report = { count: this.pending, latest: this.latest };
    this.pending = 0;
    this.lastAlertAt = now;
    return report;
  }

  /**
   * Clear all state.
   * @internal
   */
  reset(): void {
    this.pending = 0;
    this.latest = "";
    this.lastAlertAt = null;
  }
}

/** Singleton instance for the notifier's lost-notification alerts. */
export const lostNotifications = new LostNotificationTracker();
