-- AlterTable
ALTER TABLE "channels" DROP COLUMN "username",
ADD COLUMN     "rawData" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "username" TEXT;
