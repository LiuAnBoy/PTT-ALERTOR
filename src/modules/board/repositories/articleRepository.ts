import { prisma } from "../../../core/prisma";
import { logError } from "../../user/services/errorLogger";
import type { ArticleDetail, RawArticle } from "../types/article";

/**
 * Insert only new articles to the database. Existing articles are skipped.
 * @param articles - Array of raw articles to persist.
 * @returns Number of new articles inserted.
 */
export async function insertNewArticles(articles: RawArticle[]): Promise<number> {
  if (articles.length === 0) return 0;

  try {
    const result = await prisma.article.createMany({
      data: articles.map((article) => ({
        code: article.code,
        timestamp: article.timestamp,
        title: article.title,
        link: article.link,
        author: article.author,
        board: article.board,
        pushSum: article.pushSum,
      })),
      skipDuplicates: true,
    });

    return result.count;
  } catch (err) {
    await logError("FATAL", "CRAWLER", "PostgreSQL insert failed", {
      board: articles[0]?.board,
      articleCode: articles[0]?.code,
      errorMsg: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Update article detail fields only if there are changes.
 * Compares push counts and content to decide whether to update.
 * @param code - The article code (primary key).
 * @param detail - The parsed detail data.
 * @returns True if the article was updated, false if no changes.
 */
export async function updateArticleDetail(code: string, detail: ArticleDetail): Promise<boolean> {
  const current = await prisma.article.findUnique({
    where: { code },
    select: { positive: true, negative: true, neutral: true, content: true },
  });

  if (!current) return false;

  const hasChanges =
    current.positive !== detail.positive ||
    current.negative !== detail.negative ||
    current.neutral !== detail.neutral ||
    current.content !== detail.content;

  if (!hasChanges) return false;

  await prisma.article.update({
    where: { code },
    data: {
      ip: detail.ip,
      content: detail.content,
      pushSum: detail.positive - detail.negative,
      positive: detail.positive,
      negative: detail.negative,
      neutral: detail.neutral,
      comments: detail.comments as object[],
    },
  });

  return true;
}
