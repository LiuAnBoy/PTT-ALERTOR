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

/**
 * Count subscriptions per keyword for a board.
 * @param board - The board name.
 * @param limit - Maximum number of rows to return (sorted by subscriber count desc).
 * @returns Array of `{ keyword, subs }` ordered by subs desc, then keyword asc.
 */
export async function countByBoard(
  board: string,
  limit = 50,
): Promise<{ keyword: string; subs: number }[]> {
  const rows = await getPrisma().subscription.groupBy({
    by: ["keyword"],
    where: { board },
    _count: { _all: true },
    orderBy: [{ _count: { keyword: "desc" } }, { keyword: "asc" }],
    take: limit,
  });
  return rows.map((r) => ({ keyword: r.keyword, subs: r._count._all }));
}

/**
 * Get one subscription by id.
 * @param id - The subscription UUID.
 * @returns The subscription record or null.
 */
export async function getSubscriptionById(id: string) {
  return getPrisma().subscription.findUnique({ where: { id } });
}

/**
 * Find one subscription by user, board, and keyword.
 * @param userId - The user's UUID.
 * @param board - The board name.
 * @param keyword - The keyword.
 * @returns The subscription record or null.
 */
export async function findSubscription(userId: string, board: string, keyword: string) {
  return getPrisma().subscription.findUnique({
    where: { userId_board_keyword: { userId, board, keyword } },
  });
}

/**
 * Set or clear the mail text of a subscription.
 * @param id - The subscription UUID.
 * @param replyContent - The mail text, or null to turn mail off for it.
 * @returns The updated subscription record.
 */
export async function setReplyContent(id: string, replyContent: string | null) {
  return getPrisma().subscription.update({ where: { id }, data: { replyContent } });
}

/**
 * Set whether the mail quotes the original article.
 * @param id - The subscription UUID.
 * @param replyIncludeOriginal - True to attach the original article.
 * @returns The updated subscription record.
 */
export async function setReplyIncludeOriginal(id: string, replyIncludeOriginal: boolean) {
  return getPrisma().subscription.update({ where: { id }, data: { replyIncludeOriginal } });
}
