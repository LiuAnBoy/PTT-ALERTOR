/**
 * Spaces out PTT logins per account. PTT's DDoS/BOT detection suspends an account that logs in
 * repeatedly in a short time (about 5 minutes, growing up to 12 hours if it continues), so a
 * mail or verify job logs in only when the account has not logged in for {@link LOGIN_GAP_MS}.
 * The reservation lives in Redis; the startup flush clears it, which at worst allows one early
 * login after a restart.
 */
import { createLogger } from "../../../core/logger";
import { redis } from "../../../core/redis";

const logger = createLogger("MAIL");

/** Minimum time between two logins of one PTT account. */
export const LOGIN_GAP_MS = 180_000;
/** How long logins of an account are held after PTT reported it suspended. */
export const THROTTLE_HOLD_MS = 600_000;
/** Wait used when Redis cannot be asked, so a Redis error never lets a login through. */
const UNKNOWN_WAIT_MS = 60_000;

/**
 * Redis key of one account's login reservation.
 * @param pttId - PTT id; ids are case-insensitive on PTT.
 * @returns The key `mail:login:<pttId in lower case>`.
 */
function gateKey(pttId: string): string {
  return `mail:login:${pttId.trim().toLowerCase()}`;
}

/**
 * Reserve the next login of an account, atomically.
 * @param pttId - PTT id about to log in.
 * @returns 0 when the login may go ahead now (the gap is reserved from now on), otherwise the
 *   milliseconds to wait before asking again.
 */
export async function reserveLogin(pttId: string): Promise<number> {
  try {
    const key = gateKey(pttId);
    if ((await redis.set(key, "1", "PX", LOGIN_GAP_MS, "NX")) === "OK") return 0;
    const ttl = await redis.pttl(key);
    return ttl > 0 ? ttl : 1_000;
  } catch (err) {
    logger.error(`Login gate unavailable: ${(err as Error).message}`);
    return UNKNOWN_WAIT_MS;
  }
}

/**
 * Hold every login of an account for {@link THROTTLE_HOLD_MS}, after PTT suspended it.
 * @param pttId - The suspended PTT id.
 */
export async function holdLogins(pttId: string): Promise<void> {
  try {
    await redis.set(gateKey(pttId), "1", "PX", THROTTLE_HOLD_MS);
  } catch (err) {
    logger.error(`Login gate hold failed: ${(err as Error).message}`);
  }
}
