-- Phase E10.5 — Browser context configuration on Project + Download table.
--
-- All Project columns nullable / default; existing projects work unchanged
-- (the MCP session falls back to current defaults when fields are null).
-- The Download table is brand new and linked optionally to RunResult so
-- ad-hoc browser sessions (no run) can still record downloads.

ALTER TABLE "Project" ADD COLUMN "contextViewport"          TEXT;
ALTER TABLE "Project" ADD COLUMN "contextDevice"            TEXT;
ALTER TABLE "Project" ADD COLUMN "contextLocale"            TEXT;
ALTER TABLE "Project" ADD COLUMN "contextUserAgent"         TEXT;
ALTER TABLE "Project" ADD COLUMN "contextColorScheme"       TEXT;
ALTER TABLE "Project" ADD COLUMN "contextPermissions"       TEXT;
ALTER TABLE "Project" ADD COLUMN "contextGeolocation"       TEXT;
ALTER TABLE "Project" ADD COLUMN "contextHttpCredentials"   TEXT;
ALTER TABLE "Project" ADD COLUMN "contextExtraHeaders"      TEXT;
ALTER TABLE "Project" ADD COLUMN "contextIgnoreHttpsErrors" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "contextProxyServer"       TEXT;
ALTER TABLE "Project" ADD COLUMN "contextProxyBypass"       TEXT;
ALTER TABLE "Project" ADD COLUMN "autoAcceptDialogs"        BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "Download" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runResultId" TEXT,
    "suggestedFilename" TEXT NOT NULL,
    "storedFilename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Download_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Download_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Download_projectId_capturedAt_idx" ON "Download"("projectId", "capturedAt");
CREATE INDEX "Download_runResultId_idx" ON "Download"("runResultId");
