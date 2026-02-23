-- DropIndex
DROP INDEX IF EXISTS "articles_expireAt_idx";

-- AlterTable
ALTER TABLE "articles" DROP COLUMN "expireAt";
