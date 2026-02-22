/**
 * Raw article data parsed from board list page.
 */
export interface RawArticle {
  code: string;
  timestamp: bigint;
  title: string;
  link: string;
  author: string | null;
  board: string;
  pushSum: number;
}

/**
 * Article detail data parsed from article detail page.
 */
export interface ArticleDetail {
  ip: string | null;
  content: string;
  positive: number;
  negative: number;
  neutral: number;
  comments: ArticleComment[];
}

/**
 * Comment structure stored as JSONB in the Article table.
 */
export interface ArticleComment {
  tag: string;
  userId: string;
  content: string;
  dateTime: string;
}
