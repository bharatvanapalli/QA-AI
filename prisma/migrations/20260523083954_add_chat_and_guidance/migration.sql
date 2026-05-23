-- AlterTable
ALTER TABLE "Project" ADD COLUMN "aiGuidance" TEXT;

-- AlterTable
ALTER TABLE "RunResult" ADD COLUMN "chatHistory" TEXT;

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN "userGuidance" TEXT;
