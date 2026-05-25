-- AlterTable
ALTER TABLE "BlockedItem" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "BlockedItem" ADD COLUMN "assignee" TEXT;
ALTER TABLE "BlockedItem" ADD COLUMN "resolveNote" TEXT;
ALTER TABLE "BlockedItem" ADD COLUMN "aiSummary" TEXT;
ALTER TABLE "BlockedItem" ADD COLUMN "aiCategory" TEXT;
ALTER TABLE "BlockedItem" ADD COLUMN "aiRootCauseTcId" TEXT;
ALTER TABLE "BlockedItem" ADD COLUMN "aiSuggestedFix" TEXT;
ALTER TABLE "BlockedItem" ADD COLUMN "aiAnalyzedAt" DATETIME;
