-- Phase E3 — code-diff awareness.
-- Pure additive migration. All new fields on Project are nullable so existing
-- rows stay valid; DiffContext is a brand-new table.

ALTER TABLE "Project" ADD COLUMN "repoUrl"       TEXT;
ALTER TABLE "Project" ADD COLUMN "defaultBranch" TEXT;
ALTER TABLE "Project" ADD COLUMN "gitProvider"   TEXT;

CREATE TABLE "DiffContext" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "projectId"     TEXT NOT NULL,
    "sprintId"      TEXT,
    "ref"           TEXT NOT NULL,
    "baseRef"       TEXT NOT NULL,
    "changedFiles"  TEXT NOT NULL,
    "changedModules" TEXT NOT NULL,
    "summary"       TEXT,
    "fetchedAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiffContext_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DiffContext_projectId_sprintId_idx" ON "DiffContext"("projectId", "sprintId");
CREATE INDEX "DiffContext_projectId_fetchedAt_idx" ON "DiffContext"("projectId", "fetchedAt");
