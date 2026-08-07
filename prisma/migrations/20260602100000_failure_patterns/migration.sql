-- 20260602100000_failure_patterns
-- Phase G — Cross-run failure-pattern store. After every failed/blocked
-- RunResult with an RCA, the postMortem agent classifies the failure into a
-- project-scoped reusable pattern. The conductor injects the top patterns
-- (by occurrence) into its system prompt for the NEXT run so the agent
-- adapts strategy on its own instead of re-discovering each trap.
--
-- All additive — no existing rows touched. Safe to roll forward.

CREATE TABLE "FailurePattern" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "exampleRunResultIds" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FailurePattern_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FailurePattern_projectId_signature_key" ON "FailurePattern"("projectId", "signature");
CREATE INDEX "FailurePattern_projectId_occurrences_idx" ON "FailurePattern"("projectId", "occurrences");
CREATE INDEX "FailurePattern_projectId_lastSeenAt_idx" ON "FailurePattern"("projectId", "lastSeenAt");
