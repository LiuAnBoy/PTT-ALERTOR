import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { getPrisma } from "../../../core/prisma";
import { redis } from "../../../core/redis";
import { fetchNewArticles, updateActiveArticles } from "../services/crawlerService";

const BOARD = "Gossiping";
const CACHE_KEY = `board:${BOARD}:articles`;

beforeAll(async () => {
  await getPrisma().$connect();
  await redis.connect();
});

afterAll(async () => {
  // Clean up test data
  await getPrisma().article.deleteMany({ where: { board: BOARD } });
  await redis.del(CACHE_KEY);
  await getPrisma().$disconnect();
  redis.disconnect();
});

describe("CrawlerService", () => {
  it("should insert new articles with detail data", async () => {
    // Clean state
    await getPrisma().article.deleteMany({ where: { board: BOARD } });
    await redis.del(CACHE_KEY);

    const articles = await fetchNewArticles(BOARD);

    expect(articles.length).toBeGreaterThan(0);
    console.log(`\nInserted ${articles.length} new articles`);

    // Verify DB records have detail data
    const first = await getPrisma().article.findUnique({
      where: { code: articles[0].code },
    });

    expect(first).not.toBeNull();
    expect(first!.title).toBeTruthy();
    expect(first!.board).toBe(BOARD);
    expect(first!.content).toBeTruthy();
    expect(first!.ip).toBeTruthy();
    expect(typeof first!.positive).toBe("number");
    expect(typeof first!.negative).toBe("number");
    expect(typeof first!.neutral).toBe("number");

    console.log(`DB record: ${first!.title}`);
    console.log(`  ip: ${first!.ip}`);
    console.log(`  content: ${first!.content!.substring(0, 60).replace(/\n/g, " ")}...`);
    console.log(
      `  positive: ${first!.positive}, negative: ${first!.negative}, neutral: ${first!.neutral}`,
    );
    console.log(
      `  comments: ${Array.isArray(first!.comments) ? (first!.comments as unknown[]).length : 0} 則`,
    );
    // Verify Redis cache
    const cachedCount = await redis.zcard(CACHE_KEY);
    expect(cachedCount).toBe(articles.length);
    console.log(`Redis cache: ${cachedCount} articles`);
  }, 60000);

  it("should not insert duplicate articles on second run", async () => {
    const articles = await fetchNewArticles(BOARD);

    // All articles should be filtered by Redis cache
    expect(articles.length).toBe(0);
    console.log("\nSecond run: 0 new articles (all cached)");
  }, 30000);

  it("should update active articles with latest detail", async () => {
    const updated = await updateActiveArticles();

    console.log(`\nUpdated ${updated} active articles`);
    // First run just inserted details, so most should have no changes
    expect(typeof updated).toBe("number");
  }, 120000);
});
