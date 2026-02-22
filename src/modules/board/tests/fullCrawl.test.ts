import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { ARTICLE_DELETED, fetchDetail } from "../services/detailFetcher";
import { fetchHtml } from "../services/htmlFetcher";

describe("Full Crawl", () => {
  it("should crawl Gossiping board with details", async () => {
    const articles = await fetchHtml("Gossiping");
    console.log(`\n========== Gossiping: ${articles.length} articles ==========\n`);

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const detail = await fetchDetail(a.link);

      console.log(`[${i + 1}] ${a.title}`);
      console.log(`    code:    ${a.code}`);
      console.log(`    author:  ${a.author}`);
      console.log(`    link:    ${a.link}`);
      console.log(`    pushSum: ${a.pushSum}`);

      if (detail && detail !== ARTICLE_DELETED) {
        console.log(`    ip:       ${detail.ip}`);
        console.log(`    positive: ${detail.positive}`);
        console.log(`    negative: ${detail.negative}`);
        console.log(`    neutral:  ${detail.neutral}`);
        console.log(`    comments: ${detail.comments.length} 則`);
        console.log(`    content:  ${detail.content.substring(0, 80).replace(/\n/g, " ")}...`);
      } else {
        console.log(`    detail:   FAILED`);
      }
      console.log();
    }

    expect(articles.length).toBeGreaterThan(0);
  }, 60000);
});
