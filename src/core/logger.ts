import pino from "pino";
import { Transform } from "stream";

import type { ModuleTag } from "../types";

const MAX_MODULE_WIDTH = 13; // "MAINTENANCE" (11) + 2 spaces
const MAX_STATUS_WIDTH = 6; // "ERROR" (5) + 1 space

// ANSI color codes
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RED_BG = "\x1b[41m\x1b[37m";

const LEVEL_MAP: Record<number, { label: string; color: string; fullLine: boolean }> = {
  10: { label: "TRACE", color: GRAY, fullLine: false },
  20: { label: "DEBUG", color: GRAY, fullLine: false },
  30: { label: "INFO", color: GREEN, fullLine: false },
  40: { label: "WARN", color: YELLOW, fullLine: false },
  50: { label: "ERROR", color: RED, fullLine: true },
  60: { label: "FATAL", color: RED_BG, fullLine: true },
};

/**
 * Format a Date to `YYYY-MM-DD HH:mm:ss`.
 * @param d - The date to format.
 * @returns The formatted timestamp string.
 */
function formatTime(d: Date): string {
  return [
    d.getFullYear(),
    "-",
    String(d.getMonth() + 1).padStart(2, "0"),
    "-",
    String(d.getDate()).padStart(2, "0"),
    " ",
    String(d.getHours()).padStart(2, "0"),
    ":",
    String(d.getMinutes()).padStart(2, "0"),
    ":",
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
}

import { config } from "./config";

const isDev = !config.isProduction;

/**
 * Custom transform stream that formats pino JSON logs
 * into aligned human-readable output.
 *
 * Format: `time | status | module | message`
 */
const prettyStream = new Transform({
  transform(chunk, _encoding, callback) {
    try {
      const obj = JSON.parse(chunk.toString());
      const info = LEVEL_MAP[obj.level] ?? LEVEL_MAP[30];
      const time = formatTime(new Date());
      const status = info.label.padEnd(MAX_STATUS_WIDTH);
      const module = ((obj.module as string) ?? "SERVER").padEnd(MAX_MODULE_WIDTH);
      const msg = obj.msg ?? "";

      const line = info.fullLine
        ? `${info.color}${status} | ${module} | ${msg} [${time}]${RESET}\n`
        : `${info.color}${status}${RESET} | ${CYAN}${module}${RESET} | ${msg} ${CYAN}[${time}]${RESET}\n`;

      callback(null, line);
    } catch {
      callback(null, chunk);
    }
  },
});
prettyStream.pipe(process.stdout);

/**
 * Base pino logger instance with custom aligned formatting.
 *
 * Log format: `time | status | module | message`
 */
export const baseLogger = pino(
  {
    level: isDev ? "debug" : "info",
    formatters: {
      level(_label: string, number: number) {
        return { level: number };
      },
    },
    timestamp: false,
  },
  isDev ? prettyStream : pino.destination(1),
);

/**
 * Create a child logger for a specific module.
 * @param tag - The module tag for log identification.
 * @returns A pino child logger bound with the module tag.
 */
export function createLogger(tag: ModuleTag) {
  return baseLogger.child({ module: tag });
}
