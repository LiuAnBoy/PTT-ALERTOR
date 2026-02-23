import { getPrisma } from "../../../core/prisma";

/**
 * Create a new user.
 * @param username - Optional display name.
 * @returns The created user record.
 */
export async function createUser(username?: string) {
  return getPrisma().user.create({ data: { username } });
}
