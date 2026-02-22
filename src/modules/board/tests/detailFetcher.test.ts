import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { ARTICLE_DELETED, fetchDetail } from "../services/detailFetcher";
import { fetchHtml } from "../services/htmlFetcher";

describe("Detail Fetcher", () => {
  it("should fetch detail from a Gossiping article", async () => {
    // Get a real article link from the board
    const articles = await fetchHtml("Gossiping");
    expect(articles.length).toBeGreaterThan(0);

    const article = articles[0];
    console.log(`\nFetching detail for: ${article.title}`);
    console.log(`Link: ${article.link}\n`);

    const detail = await fetchDetail(article.link);
    expect(detail).not.toBeNull();
    expect(detail).not.toBe(ARTICLE_DELETED);

    if (detail && detail !== ARTICLE_DELETED) {
      console.log(`IP: ${detail.ip}`);
      console.log(`Content length: ${detail.content.length} chars`);
      console.log(`Content preview: ${detail.content.substring(0, 200)}...`);
      console.log(`\nPositive (推): ${detail.positive}`);
      console.log(`Negative (噓): ${detail.negative}`);
      console.log(`Neutral  (→): ${detail.neutral}`);
      console.log(`Total comments: ${detail.comments.length}`);

      if (detail.comments.length > 0) {
        console.log(`\nFirst 3 comments:`);
        detail.comments.slice(0, 3).forEach((c, i) => {
          console.log(`  [${i + 1}] ${c.tag} ${c.userId}: ${c.content} (${c.dateTime})`);
        });
      }

      expect(detail.content.length).toBeGreaterThan(0);
      expect(detail.positive + detail.negative + detail.neutral).toBe(detail.comments.length);
      expect(typeof detail.positive).toBe("number");
      expect(typeof detail.negative).toBe("number");
      expect(typeof detail.neutral).toBe("number");
    }
  }, 20000);
});
