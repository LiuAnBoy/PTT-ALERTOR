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
 * Error codes notify_service is known to return (its docs and source). Only these are logged;
 * anything else is logged as "unrecognised", so a response cannot write an arbitrary string,
 * such as an echoed key, into the log.
 */
const KNOWN_NOTIFY_CODES = new Set([
  "bad_request",
  "channel_not_found",
  "forbidden",
  "internal_error",
  "invalid_param",
  "invalid_service_key",
  "message_not_owned",
  "operator_only",
  "rate_limited",
  "unknown_method",
]);

/** Error names fetch and AbortSignal.timeout raise. Any other name is logged as "UnknownError". */
const KNOWN_FETCH_ERRORS = new Set(["AbortError", "TimeoutError", "TypeError"]);

/**
 * Name of a caught fetch failure, safe to log: a known fetch error name, else "UnknownError".
 * Never throws, even when reading the name does.
 * @param err - The caught value.
 * @returns The name to log.
 */
function fetchErrorName(err: unknown): string {
  try {
    return err instanceof Error && KNOWN_FETCH_ERRORS.has(err.name) ? err.name : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

/**
 * Message of a caught direct-route failure for the log. Never throws, even when reading the
 * message or converting the value to a string does.
 * @param err - The caught value.
 * @returns The message to log.
 */
function directErrorMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unprintable error";
  }
}

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
      typeof rawCode === "string" && KNOWN_NOTIFY_CODES.has(rawCode) ? rawCode : "unrecognised";
    logger.error(`Admin alert via Service Manager failed: status=${res.status} code=${code}`);
    return false;
  } catch (err) {
    logger.error(`Admin alert via Service Manager failed: ${fetchErrorName(err)}`);
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
    logger.error(`Failed to send admin alert: ${directErrorMessage(err)}`);
  }
}
