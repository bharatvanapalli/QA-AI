-- 20260603000000_kb_pageurl_unique
-- P3-4 — make pageUrl part of the KnowledgeBaseLocator unique key.
--
-- The old constraint @@unique([projectId, element]) collapsed semantically
-- different elements that share a label across pages: "Login button" on a
-- marketing nav and "Login button" on the auth form both upserted to the
-- same row, so the auth button's healthScore degraded under marketing-nav
-- failures.
--
-- The new constraint @@unique([projectId, element, pageUrl]) keeps them as
-- separate rows. pageUrl is changed from nullable → non-null with default
-- '' so NULL distinctness doesn't re-permit the collision (both SQLite and
-- Postgres treat NULLs as distinct in unique constraints — same row would
-- still be impossible to find, but the dedupe wouldn't fire either).
--
-- The new constraint is STRICTLY WEAKER than the old one (adding columns to
-- a key allows more rows, never fewer), so legacy data is preserved by
-- definition; backfill NULL→'' is the only data step.
--
-- Generic rule: KB unique constraint includes pageUrl. Legacy rows backfill
-- to '' (NEVER NULL — both SQLite and Postgres treat NULLs as distinct in
-- unique constraints, which would re-permit the duplicates).

-- 1. Backfill NULL pageUrl → ''
UPDATE "KnowledgeBaseLocator" SET "pageUrl" = '' WHERE "pageUrl" IS NULL;

-- 2. SQLite can't ALTER COLUMN to add NOT NULL, so recreate the table
--    using Prisma's standard rebuild pattern (matches what `prisma migrate
--    dev` would auto-emit for this change).
CREATE TABLE "new_KnowledgeBaseLocator" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "projectId"       TEXT NOT NULL,
  "element"         TEXT NOT NULL,
  "selector"        TEXT NOT NULL,
  "strategy"        TEXT,
  "occurrences"     INTEGER NOT NULL DEFAULT 1,
  "healthScore"     INTEGER NOT NULL DEFAULT 100,
  "lastHealedAt"    DATETIME,
  "intent"          TEXT,
  "accessibleName"  TEXT,
  "role"            TEXT,
  "pageUrl"         TEXT NOT NULL DEFAULT '',
  "domAnchor"       TEXT,
  "failureCount"    INTEGER NOT NULL DEFAULT 0,
  "lastFailedAt"    DATETIME,
  "healHistory"     TEXT,
  "parentProjectId" TEXT,
  "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       DATETIME NOT NULL,
  CONSTRAINT "KnowledgeBaseLocator_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_KnowledgeBaseLocator" (
  "id", "projectId", "element", "selector", "strategy", "occurrences",
  "healthScore", "lastHealedAt", "intent", "accessibleName", "role",
  "pageUrl", "domAnchor", "failureCount", "lastFailedAt", "healHistory",
  "parentProjectId", "createdAt", "updatedAt"
)
SELECT
  "id", "projectId", "element", "selector", "strategy", "occurrences",
  "healthScore", "lastHealedAt", "intent", "accessibleName", "role",
  COALESCE("pageUrl", ''), "domAnchor", "failureCount", "lastFailedAt",
  "healHistory", "parentProjectId", "createdAt", "updatedAt"
FROM "KnowledgeBaseLocator";

DROP TABLE "KnowledgeBaseLocator";
ALTER TABLE "new_KnowledgeBaseLocator" RENAME TO "KnowledgeBaseLocator";

-- 3. New compound unique + indexes.
CREATE UNIQUE INDEX "KnowledgeBaseLocator_projectId_element_pageUrl_key"
  ON "KnowledgeBaseLocator"("projectId", "element", "pageUrl");
CREATE INDEX "KnowledgeBaseLocator_projectId_idx"
  ON "KnowledgeBaseLocator"("projectId");
CREATE INDEX "KnowledgeBaseLocator_projectId_healthScore_idx"
  ON "KnowledgeBaseLocator"("projectId", "healthScore");
