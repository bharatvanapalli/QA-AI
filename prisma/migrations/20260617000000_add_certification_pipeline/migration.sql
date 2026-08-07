-- Phase C — Certification Pipeline schema additions.
-- All columns are additive/nullable with safe defaults so existing rows are untouched.

-- RunResult: export state JSON blob (state, gaps, artifacts, parity report, certification ref)
ALTER TABLE "RunResult" ADD COLUMN "exportMeta" TEXT;

-- Project: per-project export strictness gate
-- 'strict' = 0 kbMiss (certified); 'standard' = draft allowed; 'exploratory' = wide draft
-- NULL treated as 'standard' by the contract validator
ALTER TABLE "Project" ADD COLUMN "exportStrictness" TEXT;

-- KnowledgeBaseLocator: KB lifecycle columns
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "lastUsedAt"      DATETIME;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "deprecated"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "KnowledgeBaseLocator" ADD COLUMN "updatedByRunId"  TEXT;

-- ExportCertification: first-class certification record (one per framework per journey per attempt)
CREATE TABLE "ExportCertification" (
  "id"                 TEXT     NOT NULL PRIMARY KEY,
  "projectId"          TEXT     NOT NULL,
  "runId"              TEXT     NOT NULL,
  "framework"          TEXT     NOT NULL,
  "journeySlug"        TEXT     NOT NULL,
  "sourceRunResultIds" TEXT     NOT NULL,  -- JSON array of RunResult.id strings
  "irHash"             TEXT,               -- SHA256 of concatenated replayIrJson content
  "actionJournalHash"  TEXT,               -- SHA256 of the Evidence Bundle (serialised actions)
  "packageHash"        TEXT,               -- SHA256 of the generated spec files
  "status"             TEXT     NOT NULL DEFAULT 'pending',
  -- pending | draft | repairing | incomplete_evidence | not_exportable | certified
  "parityMatched"      BOOLEAN,
  "mcpVerdict"         TEXT,               -- 'pass' | 'fail' | 'blocked' | 'skipped'
  "runnerVerdict"      TEXT,               -- execution harness verdict
  "kbMissCount"        INTEGER  NOT NULL DEFAULT 0,
  "repairRound"        INTEGER  NOT NULL DEFAULT 0,
  "gaps"               TEXT,               -- JSON array of {type, description, pageUrl?}
  "artifacts"          TEXT,               -- JSON array of retained artifact relative paths
  "pipelineTraceId"    TEXT,               -- lineage: runId + journeySlug + attempt
  "certifiedAt"        DATETIME,
  "createdAt"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE,
  FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE
);

CREATE INDEX "ExportCertification_projectId_idx"       ON "ExportCertification"("projectId");
CREATE INDEX "ExportCertification_runId_idx"           ON "ExportCertification"("runId");
CREATE INDEX "ExportCertification_status_createdAt_idx" ON "ExportCertification"("status", "createdAt");
