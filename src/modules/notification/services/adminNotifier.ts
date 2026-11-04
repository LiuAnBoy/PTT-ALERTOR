import { config } from "../../../core/config";
import { createLogger } from "../../../core/logger";
import { getAdapter } from "../../broadcast/registry";

const logger = createLogger("BOT");

/** Severity shown by notify_service for an admin alert. */
export type AdminAlertLevel = "error" | "warning" | "success";

/** The notify_service response envelope, as far as this module reads it. */
interface Envelope {
  success?: unknown;
  payload?: { code?: unknown };
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Remove the leading emoji (with a variation selector) and the whitespace after it.
 * notify_service prefixes its own level emoji, so the Service Manager route drops the text's own.
 * @param text - Alert text, possibly starting with an emoji.
 * @returns The text without its leading emoji.
 */
function stripLeadingEmoji(text: string): string {
  return text.replace(/^\p{Extended_Pictographic}[️‍]*\s*/u, "");
}

/**
 * Whether any admin route is configured.
 * @returns True when Service Manager or a direct admin Telegram chat is set.
 */
export function isAdminRouteConfigured(): boolean {
  return config.notify.enabled || Boolean(config.telegram.adminChatId);
}

/**
 * Post the alert to Service Manager's admin channel.
 * Never logs the key, the request or the error object.
 * @param text - Alert text, already stripped.
 * @param level - Alert severity.
 * @returns True only on HTTP 2xx with `success: true` in the envelope.
 */
async function sendViaServiceManager(text: string, level: AdminAlertLevel): Promise<boolean> {
  try {
    const res = await fetch(`${config.notify.url}/v1/notify/telegram`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.notify.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: config.notify.adminChannel,
        method: "sendMessage",
        params: { text, parse_mode: "none" },
        level,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let envelope: Envelope | null;
    try {
      envelope = (await res.json()) as Envelope | null;
    } catch {
      envelope = null;
    }
    if (res.ok && envelope?.success === true) return true;
    const rawCode = envelope?.payload?.code;
    const code =
      typeof rawCode === "string" && /^[a-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "unrecognised";
    logger.error(`Admin alert via Service Manager failed: status=${res.status} code=${code}`);
    return false;
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error(`Admin alert via Service Manager failed: ${name}`);
    return false;
  }
}

/**
 * Send an admin alert: to Service Manager's admin channel when SERVICE_KEY is set, and to
 * ADMIN_TELEGRAM_ID directly when that route is not configured or did not deliver.
 * Never throws.
 * @param text - Alert text (the direct route sends it unchanged).
 * @param level - Alert severity for the Service Manager route.
 * @returns Resolves once the alert was handed to a route or every route failed.
 */
export async function sendAdminAlert(text: string, level: AdminAlertLevel): Promise<void> {
  if (config.notify.enabled && (await sendViaServiceManager(stripLeadingEmoji(text), level))) {
    return;
  }
  const chatId = config.telegram.adminChatId;
  if (!chatId) return;
  try {
    await getAdapter("TELEGRAM").sendAlert(chatId, text);
  } catch (err) {
    logger.error(`Failed to send admin alert: ${(err as Error).message}`);
  }
}
