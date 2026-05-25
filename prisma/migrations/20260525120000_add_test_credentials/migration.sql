-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'staging',
    "framework" TEXT NOT NULL DEFAULT 'playwright-pom',
    "targetUrl" TEXT,
    "aiGuidance" TEXT,
    "aiProvider" TEXT NOT NULL DEFAULT 'claude',
    "testCredentials" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("aiGuidance", "aiProvider", "createdAt", "environment", "framework", "id", "name", "targetUrl", "updatedAt", "userId") SELECT "aiGuidance", "aiProvider", "createdAt", "environment", "framework", "id", "name", "targetUrl", "updatedAt", "userId" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
