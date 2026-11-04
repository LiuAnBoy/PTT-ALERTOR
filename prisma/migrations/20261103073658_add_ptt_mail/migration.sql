-- CreateEnum
CREATE TYPE "MailRequestStatus" AS ENUM ('OFFERED', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "replyContent" TEXT,
ADD COLUMN     "replyIncludeOriginal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ptt_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pttId" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "invalidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ptt_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "articleCode" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "status" "MailRequestStatus" NOT NULL DEFAULT 'OFFERED',
    "error" TEXT,
    "chatId" TEXT,
    "messageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ptt_accounts_userId_key" ON "ptt_accounts"("userId");

-- CreateIndex
CREATE INDEX "mail_requests_status_idx" ON "mail_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "mail_requests_userId_articleCode_key" ON "mail_requests"("userId", "articleCode");

-- AddForeignKey
ALTER TABLE "ptt_accounts" ADD CONSTRAINT "ptt_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
