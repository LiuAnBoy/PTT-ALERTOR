/*
  Warnings:

  - Added the required column `expireAt` to the `articles` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "articles" ADD COLUMN     "expireAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "articles_expireAt_idx" ON "articles"("expireAt");
