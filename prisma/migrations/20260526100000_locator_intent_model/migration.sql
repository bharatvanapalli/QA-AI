-- Phase E1 (BUILD_PLAN_V2): self-healing locator intent model.
-- Pure additive ALTER TABLE — all new columns nullable, no existing-row rewrite.

ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "intent"          TEXT;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "accessibleName"  TEXT;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "role"            TEXT;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "pageUrl"         TEXT;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "domAnchor"       TEXT;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "failureCount"    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "lastFailedAt"    DATETIME;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "healHistory"     TEXT;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "parentProjectId" TEXT;

CREATE INDEX "KnowledgeBaseLocator_projectId_healthScore_idx" ON "KnowledgeBaseLocator"("projectId", "healthScore");
