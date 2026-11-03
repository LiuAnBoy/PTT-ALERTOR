import type { MailRequest, MailRequestStatus } from "@prisma/client";

import { getPrisma } from "../../../core/prisma";

/** Asia/Taipei is UTC+8 all year (no daylight saving). */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Maximum successful claims (PTT login attempts) per request. */
export const MAX_MAIL_ATTEMPTS = 3;

/** Fields stored when a mail button is offered. */
export interface MailOfferInput {
  userId: string;
  board: string;
  articleCode: string;
  author: string;
  title: string;
  keyword: string;
}

/** Outcome of an atomic claim. */
export type ClaimResult =
  | { kind: "claimed"; request: MailRequest }
  | { kind: "not_found" }
  | { kind: "not_owner" }
  | { kind: "no_account" }
  | { kind: "not_claimable"; status: MailRequestStatus }
  | { kind: "attempts_exhausted"; max: number }
  | { kind: "cap_reached"; limit: number };

/**
 * Start of the Asia/Taipei calendar day containing an instant.
 * @param now - The instant.
 * @returns The UTC instant of that day's 00:00 in Asia/Taipei.
 */
export function taipeiDayStart(now: Date): Date {
  const local = now.getTime() + TAIPEI_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS);
}

/**
 * Record an offer for (userId, articleCode). An existing row is returned unchanged,
 * so a row past OFFERED is never overwritten.
 * @param input - Offer fields.
 * @returns The stored row; check `status` to see whether it is a fresh offer.
 */
export async function upsertOffer(input: MailOfferInput): Promise<MailRequest> {
  return getPrisma().mailRequest.upsert({
    where: { userId_articleCode: { userId: input.userId, articleCode: input.articleCode } },
    create: input,
    update: {},
  });
}

/**
 * Get a request by id.
 * @param id - The request UUID (the button id).
 * @returns The row or null.
 */
export async function getMailRequest(id: string): Promise<MailRequest | null> {
  return getPrisma().mailRequest.findUnique({ where: { id } });
}

/**
 * Atomically claim a request: lock the user's PttAccount row, count the user's claims made
 * today in Asia/Taipei (by queuedAt, whatever the later status, OFFERED and the row being
 * claimed excluded), and move OFFERED or FAILED to QUEUED with a conditional update that also
 * requires attempts below the limit. A row in any other status is refused before the count.
 * @param requestId - The request UUID.
 * @param userId - The user pressing the button.
 * @param dailyLimit - Maximum claims per Taipei day.
 * @param now - Claim time.
 * @returns A typed result; only `claimed` changes the row.
 */
export async function claim(
  requestId: string,
  userId: string,
  dailyLimit: number,
  now: Date,
): Promise<ClaimResult> {
  return getPrisma().$transaction(async (tx): Promise<ClaimResult> => {
    const existing = await tx.mailRequest.findUnique({ where: { id: requestId } });
    if (!existing) return { kind: "not_found" };
    if (existing.userId !== userId) return { kind: "not_owner" };

    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM ptt_accounts WHERE "userId" = ${userId} FOR UPDATE`;
    if (locked.length === 0) return { kind: "no_account" };

    if (existing.status !== "OFFERED" && existing.status !== "FAILED") {
      return { kind: "not_claimable", status: existing.status };
    }
    if (existing.attempts >= MAX_MAIL_ATTEMPTS) {
      return { kind: "attempts_exhausted", max: MAX_MAIL_ATTEMPTS };
    }

    const dayStart = taipeiDayStart(now);
    const claimedToday = await tx.mailRequest.count({
      where: {
        userId,
        id: { not: requestId },
        status: { not: "OFFERED" },
        queuedAt: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) },
      },
    });
    if (claimedToday >= dailyLimit) return { kind: "cap_reached", limit: dailyLimit };

    const { count } = await tx.mailRequest.updateMany({
      where: {
        id: requestId,
        userId,
        status: { in: ["OFFERED", "FAILED"] },
        attempts: { lt: MAX_MAIL_ATTEMPTS },
      },
      data: {
        status: "QUEUED",
        queuedAt: now,
        error: null,
        finishedAt: null,
        attempts: { increment: 1 },
      },
    });
    const current = await tx.mailRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (count === 0) return { kind: "not_claimable", status: current.status };
    return { kind: "claimed", request: current };
  });
}

/**
 * Move a request between statuses only if it is currently in one of the expected statuses.
 * @param id - The request UUID.
 * @param from - Statuses the row may be in.
 * @param to - The new status.
 * @param fields - Optional error text and finish time.
 * @returns True when the row was moved.
 */
async function transition(
  id: string,
  from: MailRequestStatus[],
  to: MailRequestStatus,
  fields: { error?: string | null; finishedAt?: Date | null } = {},
): Promise<boolean> {
  const { count } = await getPrisma().mailRequest.updateMany({
    where: { id, status: { in: from } },
    data: { status: to, ...fields },
  });
  return count > 0;
}

/**
 * QUEUED to SENDING when the worker picks the job up.
 * @param id - The request UUID.
 * @returns True when the row was QUEUED and is now SENDING.
 */
export function markSending(id: string): Promise<boolean> {
  return transition(id, ["QUEUED"], "SENDING");
}

/**
 * SENDING to SENT.
 * @param id - The request UUID.
 * @returns True when the row was moved.
 */
export function markSent(id: string): Promise<boolean> {
  return transition(id, ["SENDING"], "SENT", { error: null, finishedAt: new Date() });
}

/**
 * Mark a mail that was certainly not sent; the button may be tapped again.
 * @param id - The request UUID.
 * @param error - Short reason shown to the user.
 * @returns True when the row was moved.
 */
export function markFailed(id: string, error: string): Promise<boolean> {
  return transition(id, ["QUEUED", "SENDING"], "FAILED", { error, finishedAt: new Date() });
}

/**
 * Mark a mail whose delivery could not be confirmed; it is never retried automatically.
 * @param id - The request UUID.
 * @param error - Short reason.
 * @returns True when the row was moved.
 */
export function markUnknown(id: string, error: string): Promise<boolean> {
  return transition(id, ["QUEUED", "SENDING"], "UNKNOWN", { error, finishedAt: new Date() });
}

/**
 * Rows whose jobs a restart may have dropped.
 * @returns Requests in QUEUED or SENDING, oldest first.
 */
export async function findInFlight(): Promise<MailRequest[]> {
  return getPrisma().mailRequest.findMany({
    where: { status: { in: ["QUEUED", "SENDING"] } },
    orderBy: { queuedAt: "asc" },
  });
}

/**
 * Remember the Telegram message to edit when the request changes.
 * @param id - The request UUID.
 * @param chatId - Chat ID of the notification message.
 * @param messageId - Message ID of the notification message.
 */
export async function setMessageRef(id: string, chatId: string, messageId: string): Promise<void> {
  await getPrisma().mailRequest.update({ where: { id }, data: { chatId, messageId } });
}
