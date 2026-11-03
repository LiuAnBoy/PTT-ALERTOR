import { getPrisma } from "../../../core/prisma";

/**
 * Get the PTT account bound to a user.
 * @param userId - The user's UUID.
 * @returns The account record (password still encrypted) or null.
 */
export async function getPttAccount(userId: string) {
  return getPrisma().pttAccount.findUnique({ where: { userId } });
}

/**
 * Create or replace the PTT account of a user and clear any invalid mark.
 * @param userId - The user's UUID.
 * @param pttId - The PTT login ID.
 * @param passwordEnc - The password as produced by `encryptSecret`.
 * @returns The saved account record.
 */
export async function upsertPttAccount(userId: string, pttId: string, passwordEnc: string) {
  return getPrisma().pttAccount.upsert({
    where: { userId },
    create: { userId, pttId, passwordEnc },
    update: { pttId, passwordEnc, invalidAt: null },
  });
}

/**
 * Delete the PTT account of a user.
 * @param userId - The user's UUID.
 * @returns True when an account was deleted.
 */
export async function deletePttAccount(userId: string): Promise<boolean> {
  const { count } = await getPrisma().pttAccount.deleteMany({ where: { userId } });
  return count > 0;
}

/**
 * Mark the user's PTT account as rejected by PTT (wrong password).
 * @param userId - The user's UUID.
 * @param at - Time of the failure.
 * @returns True when an account was marked.
 */
export async function markPttAccountInvalid(userId: string, at: Date = new Date()) {
  const { count } = await getPrisma().pttAccount.updateMany({
    where: { userId },
    data: { invalidAt: at },
  });
  return count > 0;
}
