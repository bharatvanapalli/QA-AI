-- Enterprise Mode P2 — the requirements oracle.
-- Additive only: a new table + one nullable column, so existing rows (the
-- preserved trial-run history) are untouched. Hand-authored + applied via
-- `prisma migrate deploy` (see memory: prisma-migration-gotcha).

-- Atomic, independently-verifiable requirement clauses (content-hash ids).
CREATE TABLE "RequirementClause" (
    "id"                  TEXT NOT NULL PRIMARY KEY,
    "projectId"           TEXT NOT NULL,
    "sprintId"            TEXT,
    "sourceType"          TEXT NOT NULL,
    "sourceDocId"         TEXT,
    "excerpt"             TEXT NOT NULL,
    "spanStart"           INTEGER,
    "spanEnd"             INTEGER,
    "behaviourText"       TEXT NOT NULL,
    "sourcesJson"         TEXT,
    "coverageDisposition" TEXT NOT NULL DEFAULT 'uncovered',
    "dispositionReason"   TEXT,
    "dispositionBy"       TEXT,
    "dispositionAt"       DATETIME,
    "createdAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequirementClause_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RequirementClause_projectId_idx" ON "RequirementClause"("projectId");
CREATE INDEX "RequirementClause_sprintId_idx" ON "RequirementClause"("sprintId");

-- TestCase traceability to the oracle (null = not yet traced).
ALTER TABLE "TestCase" ADD COLUMN "requirementRefs" TEXT;
