import { getPrisma } from "../../../core/prisma";

/**
 * Create a new user.
 * @returns The created user record.
 */
export async function createUser() {
  return getPrisma().user.create({ data: {} });
}
