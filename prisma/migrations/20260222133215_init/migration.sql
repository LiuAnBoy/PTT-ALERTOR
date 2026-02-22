-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('WARN', 'ERROR', 'FATAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "telegramChat" BIGINT NOT NULL,
    "username" TEXT,
    "enable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "code" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "author" TEXT,
    "board" TEXT NOT NULL,
    "pushSum" INTEGER NOT NULL DEFAULT 0,
    "comments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "crawler_logs" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "module" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawler_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE INDEX "subscriptions_board_idx" ON "subscriptions"("board");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_board_keyword_key" ON "subscriptions"("userId", "board", "keyword");

-- CreateIndex
CREATE INDEX "articles_board_timestamp_idx" ON "articles"("board", "timestamp");

-- CreateIndex
CREATE INDEX "crawler_logs_level_createdAt_idx" ON "crawler_logs"("level", "createdAt");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
