/**
 * Available module tags for log alignment.
 */
export type ModuleTag =
  | "SERVER"
  | "CONFIG"
  | "BOT"
  | "CRAWLER"
  | "MATCHER"
  | "NOTIFIER"
  | "SCHEDULER"
  | "WORKER"
  | "DATABASE"
  | "REDIS"
  | "MAINTENANCE";

/**
 * Standard mutation response (POST / PUT / DELETE).
 */
export interface MutationResponse {
  success: boolean;
  message: string;
}
