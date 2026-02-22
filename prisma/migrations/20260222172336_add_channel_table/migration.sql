-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TELEGRAM');

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "platformChatId" TEXT NOT NULL,
    "username" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- Migrate existing data: copy telegramId/telegramChat/username into channels
INSERT INTO "channels" ("id", "platform", "platformUserId", "platformChatId", "username", "userId", "createdAt")
SELECT
    gen_random_uuid(),
    'TELEGRAM'::"Platform",
    "telegramId"::TEXT,
    "telegramChat"::TEXT,
    "username",
    "id",
    "createdAt"
FROM "users"
WHERE "telegramId" IS NOT NULL;

-- DropIndex
DROP INDEX "users_telegramId_key";

-- AlterTable: remove old columns from users
ALTER TABLE "users" DROP COLUMN "telegramChat",
DROP COLUMN "telegramId",
DROP COLUMN "username";

-- CreateIndex
CREATE UNIQUE INDEX "channels_platform_platformUserId_key" ON "channels"("platform", "platformUserId");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
