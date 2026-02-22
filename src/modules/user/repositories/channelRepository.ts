import type { Platform } from "@prisma/client";

import { getPrisma } from "../../../core/prisma";

/**
 * Find a channel by platform and platform user ID, including the associated user.
 * @param platform - The platform type (e.g. TELEGRAM).
 * @param platformUserId - The user ID on that platform.
 * @returns The channel with user, or null.
 */
export async function findChannelByPlatformUserId(platform: Platform, platformUserId: string) {
  return getPrisma().channel.findUnique({
    where: { platform_platformUserId: { platform, platformUserId } },
    include: { user: true },
  });
}

/**
 * Create a new channel linked to a user.
 * @param userId - The internal user UUID.
 * @param platform - The platform type.
 * @param platformUserId - The user ID on that platform.
 * @param platformChatId - The chat ID for sending notifications.
 * @param username - Optional username on the platform.
 * @returns The created channel record.
 */
export async function createChannel(
  userId: string,
  platform: Platform,
  platformUserId: string,
  platformChatId: string,
  username?: string,
) {
  return getPrisma().channel.create({
    data: { userId, platform, platformUserId, platformChatId, username },
  });
}
