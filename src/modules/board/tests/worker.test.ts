import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { Queue, Worker } from "bullmq";

import { getPrisma } from "../../../core/prisma";
import { bullmqConnection } from "../../../core/queue";
import { redis } from "../../../core/redis";
import { fetchNewArticles } from "../services/crawlerService";

const BOARD = "Gossiping";
const CACHE_KEY = `board:${BOARD}:articles`;

beforeAll(async () => {
  await getPrisma().$connect();
  await redis.connect();
});

afterAll(async () => {
  await getPrisma().article.deleteMany({ where: { board: BOARD } });
  await redis.del(CACHE_KEY);
  await getPrisma().$disconnect();
  redis.disconnect();
});

describe("CrawlerWorker", () => {
  it("should process a crawler job and save articles to DB", async () => {
    // Clean state
    await getPrisma().article.deleteMany({ where: { board: BOARD } });
    await redis.del(CACHE_KEY);

    const queue = new Queue("test-crawler-queue", { connection: bullmqConnection });

    const result = await new Promise<number>((resolve, reject) => {
      const worker = new Worker(
        "test-crawler-queue",
        async (job) => {
          const { boardName } = job.data as { boardName: string };
          const articles = await fetchNewArticles(boardName);
          return articles.length;
        },
        { connection: bullmqConnection },
      );

      worker.on("completed", async (job) => {
        const count = job.returnvalue as number;
        await worker.close();
        await queue.close();
        resolve(count);
      });

      worker.on("failed", async (_job, err) => {
        await worker.close();
        await queue.close();
        reject(err);
      });

      queue.add("crawl", { boardName: BOARD });
    });

    expect(result).toBeGreaterThan(0);
    console.log(`\nWorker processed: ${result} new articles`);

    // Verify DB has data
    const count = await getPrisma().article.count({ where: { board: BOARD } });
    expect(count).toBeGreaterThan(0);
    console.log(`DB articles: ${count}`);
  }, 60000);
});
