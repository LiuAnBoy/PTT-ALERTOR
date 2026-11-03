import { redis } from "../../core/redis";

/** Seconds a multi-step input waits for the user's next message. */
export const PENDING_TTL_SECONDS = 300;

/** What the bot is waiting for from one user. */
export type PendingState =
  | { step: "bindId" }
  | { step: "bindPassword"; pttId: string }
  | { step: "replyText"; subscriptionId: string };

/**
 * Redis key holding the pending input of one platform user.
 * @param platformUserId - The user's ID on the platform.
 * @returns The key `mail:pending:<platformUserId>`.
 */
function pendingKey(platformUserId: string): string {
  return `mail:pending:${platformUserId}`;
}

/**
 * Remember what the next message of a user is for.
 * @param platformUserId - The user's ID on the platform.
 * @param state - The step and its data; never contains a password.
 */
export async function setPending(platformUserId: string, state: PendingState): Promise<void> {
  await redis.set(pendingKey(platformUserId), JSON.stringify(state), "EX", PENDING_TTL_SECONDS);
}

/**
 * Read the pending input of a user.
 * @param platformUserId - The user's ID on the platform.
 * @returns The pending state, or null when none or unreadable.
 */
export async function getPending(platformUserId: string): Promise<PendingState | null> {
  const raw = await redis.get(pendingKey(platformUserId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingState;
  } catch {
    return null;
  }
}

/**
 * Forget the pending input of a user.
 * @param platformUserId - The user's ID on the platform.
 */
export async function clearPending(platformUserId: string): Promise<void> {
  await redis.del(pendingKey(platformUserId));
}
