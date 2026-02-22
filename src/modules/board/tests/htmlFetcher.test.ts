import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { fetchHtml } from "../services/htmlFetcher";

describe("HTML Fetcher", () => {
  it("should fetch articles from Gossiping board", async () => {
    const articles = await fetchHtml("Gossiping");

    console.log(`\nTotal articles: ${articles.length}\n`);
    articles.forEach((a, i) => {
      console.log(
        `[${i + 1}] ${a.title}\n` +
          `    code: ${a.code}\n` +
          `    author: ${a.author}\n` +
          `    pushSum: ${a.pushSum}\n` +
          `    link: ${a.link}\n`,
      );
    });

    expect(articles.length).toBeGreaterThan(0);

    const first = articles[0];
    expect(first.code).toMatch(/^[GM]\.\d+\.A\.[A-Z0-9]+$/);
    expect(first.title).toBeTruthy();
    expect(first.link).toContain("https://www.ptt.cc/bbs/");
    expect(first.author).toBeTruthy();
    expect(first.board).toBe("Gossiping");
    expect(typeof first.pushSum).toBe("number");
    expect(typeof first.timestamp).toBe("bigint");
  }, 15000);
});
