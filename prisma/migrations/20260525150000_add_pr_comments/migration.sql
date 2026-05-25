-- CreateTable: PRComment (Phase 8 governance review threads)
CREATE TABLE "PRComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "prId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PRComment_prId_fkey" FOREIGN KEY ("prId") REFERENCES "GovernancePR" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PRComment_prId_createdAt_idx" ON "PRComment"("prId", "createdAt");
