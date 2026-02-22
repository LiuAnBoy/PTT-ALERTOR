import { getPrisma } from "../../../core/prisma";

/**
 * Get all subscriptions for a user.
 * @param userId - The user's UUID.
 * @returns Array of subscription records.
 */
export async function getSubscriptions(userId: string) {
  return getPrisma().subscription.findMany({
    where: { userId },
    orderBy: [{ board: "asc" }, { keyword: "asc" }],
  });
}

/**
 * Add a subscription for a user.
 * @param userId - The user's UUID.
 * @param board - The board name.
 * @param keyword - The keyword to track.
 * @returns The created subscription record.
 */
export async function addSubscription(userId: string, board: string, keyword: string) {
  return getPrisma().subscription.create({
    data: { userId, board, keyword },
  });
}

/**
 * Delete a subscription by user, board, and keyword.
 * @param userId - The user's UUID.
 * @param board - The board name.
 * @param keyword - The keyword to remove.
 * @returns The deleted subscription record or null if not found.
 */
export async function deleteSubscription(userId: string, board: string, keyword: string) {
  return getPrisma().subscription.delete({
    where: { userId_board_keyword: { userId, board, keyword } },
  });
}

/**
 * Check if a subscription already exists.
 * @param userId - The user's UUID.
 * @param board - The board name.
 * @param keyword - The keyword.
 * @returns True if the subscription exists.
 */
export async function subscriptionExists(
  userId: string,
  board: string,
  keyword: string,
): Promise<boolean> {
  const count = await getPrisma().subscription.count({
    where: { userId, board, keyword },
  });
  return count > 0;
}
