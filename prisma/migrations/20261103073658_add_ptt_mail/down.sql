
-- DropForeignKey
ALTER TABLE "ptt_accounts" DROP CONSTRAINT "ptt_accounts_userId_fkey";

-- DropForeignKey
ALTER TABLE "mail_requests" DROP CONSTRAINT "mail_requests_userId_fkey";

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "replyContent",
DROP COLUMN "replyIncludeOriginal";

-- DropTable
DROP TABLE "ptt_accounts";

-- DropTable
DROP TABLE "mail_requests";

-- DropEnum
DROP TYPE "MailRequestStatus";

