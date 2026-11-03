import { randomUUID } from "node:crypto";

import { getPrisma } from "../../../core/prisma";
import {
  claim,
  MAX_MAIL_ATTEMPTS,
  taipeiDayStart,
  upsertOffer,
} from "../repositories/mailRequestRepository";

const prisma = getPrisma();
const now = new Date();

/** Create a user with a bound PTT account. */
async function makeUser() {
  return prisma.user.create({
    data: { pttAccount: { create: { pttId: "tester", passwordEnc: "v1.x.y.z" } } },
  });
}

/** Create an OFFERED request for a user. */
async function offer(userId: string) {
  return upsertOffer({
    userId,
    board: "Test",
    articleCode: `M.${randomUUID()}`,
    author: "seller",
    title: "title",
    keyword: "kw",
  });
}

describe("mailRequestRepository (real Postgres)", () => {
  const userIds: string[] = [];

  /** Make a user and remember it for cleanup. */
  async function user() {
    const u = await makeUser();
    userIds.push(u.id);
    return u;
  }

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("two concurrent claims of one request yield exactly one claimed", async () => {
    const u = await user();
    const req = await offer(u.id);
    const results = await Promise.all([
      claim(req.id, u.id, 20, now),
      claim(req.id, u.id, 20, now),
      claim(req.id, u.id, 20, now),
    ]);
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    const others = results.filter((r) => r.kind !== "claimed");
    expect(others).toEqual([
      { kind: "not_claimable", status: "QUEUED" },
      { kind: "not_claimable", status: "QUEUED" },
    ]);
    expect((await prisma.mailRequest.findUnique({ where: { id: req.id } }))?.status).toBe("QUEUED");
  });

  it("concurrent claims of different requests stop at the daily cap", async () => {
    const u = await user();
    const reqs = await Promise.all([1, 2, 3, 4, 5].map(() => offer(u.id)));
    const results = await Promise.all(reqs.map((r) => claim(r.id, u.id, 3, now)));
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(3);
    expect(results.filter((r) => r.kind === "cap_reached")).toHaveLength(2);
  });

  it("FAILED claims still count against the cap", async () => {
    const u = await user();
    const [a, b] = await Promise.all([offer(u.id), offer(u.id)]);
    expect((await claim(a!.id, u.id, 1, now)).kind).toBe("claimed");
    await prisma.mailRequest.update({ where: { id: a!.id }, data: { status: "FAILED" } });
    expect((await claim(b!.id, u.id, 1, now)).kind).toBe("cap_reached");
    // The failed request itself is still retappable: it is not counted against itself.
    expect((await claim(a!.id, u.id, 1, now)).kind).toBe("claimed");
  });

  it("a request past FAILED is not_claimable even at the cap", async () => {
    const u = await user();
    const [a, b] = await Promise.all([offer(u.id), offer(u.id)]);
    expect((await claim(a!.id, u.id, 1, now)).kind).toBe("claimed");
    await prisma.mailRequest.update({ where: { id: a!.id }, data: { status: "SENT" } });
    expect(await claim(a!.id, u.id, 1, now)).toEqual({ kind: "not_claimable", status: "SENT" });
    expect((await claim(b!.id, u.id, 1, now)).kind).toBe("cap_reached");
  });

  it("the last allowed attempt is claimed once and then refused", async () => {
    const u = await user();
    const req = await offer(u.id);
    await prisma.mailRequest.update({
      where: { id: req.id },
      data: { attempts: MAX_MAIL_ATTEMPTS - 1 },
    });
    expect((await claim(req.id, u.id, 20, now)).kind).toBe("claimed");
    await prisma.mailRequest.update({ where: { id: req.id }, data: { status: "FAILED" } });
    expect((await claim(req.id, u.id, 20, now)).kind).toBe("attempts_exhausted");
    expect((await prisma.mailRequest.findUnique({ where: { id: req.id } }))?.attempts).toBe(
      MAX_MAIL_ATTEMPTS,
    );
  });

  it("OFFERED rows do not count and other users' requests are refused", async () => {
    const owner = await user();
    const other = await user();
    const req = await offer(owner.id);
    await offer(owner.id);
    expect((await claim(req.id, other.id, 20, now)).kind).toBe("not_owner");
    expect((await claim(req.id, owner.id, 1, now)).kind).toBe("claimed");
    expect((await claim(randomUUID(), owner.id, 1, now)).kind).toBe("not_found");
  });

  it("a request failed three times cannot be claimed a fourth time", async () => {
    const u = await user();
    const req = await offer(u.id);
    for (let i = 1; i <= MAX_MAIL_ATTEMPTS; i++) {
      expect((await claim(req.id, u.id, 20, now)).kind).toBe("claimed");
      await prisma.mailRequest.update({ where: { id: req.id }, data: { status: "FAILED" } });
    }
    expect(await claim(req.id, u.id, 20, now)).toEqual({
      kind: "attempts_exhausted",
      max: MAX_MAIL_ATTEMPTS,
    });
    const row = await prisma.mailRequest.findUnique({ where: { id: req.id } });
    expect(row?.attempts).toBe(3);
    expect(row?.status).toBe("FAILED");
  });

  it("upsertOffer never overwrites a row past OFFERED", async () => {
    const u = await user();
    const req = await offer(u.id);
    await claim(req.id, u.id, 20, now);
    const again = await upsertOffer({
      userId: u.id,
      board: "Test",
      articleCode: req.articleCode,
      author: "changed",
      title: "changed",
      keyword: "kw",
    });
    expect(again.id).toBe(req.id);
    expect(again.status).toBe("QUEUED");
    expect(again.author).toBe("seller");
  });

  it("counts by Asia/Taipei day", () => {
    // 2026-11-03T17:00Z is 2026-11-04 01:00 in Taipei, so the day starts at 2026-11-03T16:00Z.
    expect(taipeiDayStart(new Date("2026-11-03T17:00:00Z")).toISOString()).toBe(
      "2026-11-03T16:00:00.000Z",
    );
  });
});
