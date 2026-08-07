-- E2: Auth fixture storage for pre-captured Playwright storageState injection
CREATE TABLE "AuthFixture" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "projectId"    TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "storageState" TEXT NOT NULL,
    "environment"  TEXT NOT NULL DEFAULT 'default',
    "notes"        TEXT,
    "validUntil"   DATETIME,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    DATETIME NOT NULL,
    CONSTRAINT "AuthFixture_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AuthFixture_projectId_idx" ON "AuthFixture"("projectId");
