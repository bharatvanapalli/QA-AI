-- Capture-first execution evidence.
-- Additive only: legacy RunResult rows remain readable and diagnostic-only.

ALTER TABLE "RunResult" ADD COLUMN "overallRunStatus" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "executionStatus" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "evidenceStatus" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "scriptStatus" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "evidenceCompletenessJson" TEXT;

CREATE TABLE "LocatorRecipe" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "sequenceIndex" INTEGER,
  "contractStepId" TEXT,
  "source" TEXT,
  "expressionByFramework" TEXT,
  "primaryExpression" TEXT,
  "strategy" TEXT,
  "countBefore" INTEGER,
  "countAfter" INTEGER,
  "sameElementProof" BOOLEAN NOT NULL DEFAULT false,
  "visible" BOOLEAN,
  "enabled" BOOLEAN,
  "editableWhenRequired" BOOLEAN,
  "framePathJson" TEXT,
  "shadowPathJson" TEXT,
  "locatorRecipeJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocatorRecipe_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ActionEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "sequenceIndex" INTEGER NOT NULL,
  "contractStepId" TEXT,
  "actionAttemptId" TEXT,
  "retryOfActionEvidenceId" TEXT,
  "stepId" TEXT,
  "toolName" TEXT NOT NULL,
  "actionKind" TEXT NOT NULL,
  "locatorRecipeId" TEXT,
  "valueRef" TEXT,
  "beforeSnapshotRef" TEXT,
  "actionSnapshotRef" TEXT,
  "afterSnapshotRef" TEXT,
  "traceEventRef" TEXT,
  "transitionProofJson" TEXT,
  "assertionEvidenceId" TEXT,
  "authSetupEvidenceId" TEXT,
  "exportable" BOOLEAN NOT NULL DEFAULT true,
  "evidenceJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionEvidence_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AssertionEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "assertionId" TEXT,
  "sequenceIndex" INTEGER,
  "kind" TEXT,
  "locatorRecipeId" TEXT,
  "expectedJson" TEXT,
  "actualJson" TEXT,
  "matched" BOOLEAN NOT NULL DEFAULT false,
  "containerScopeJson" TEXT,
  "source" TEXT,
  "evidenceJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssertionEvidence_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AuthSetupEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "authProfileId" TEXT,
  "mode" TEXT,
  "loginActionEvidenceIds" TEXT,
  "storageStateRef" TEXT,
  "postLoginOracleJson" TEXT,
  "sessionVerifiedAt" DATETIME,
  "expiresAt" DATETIME,
  "evidenceJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthSetupEvidence_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TraceArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "artifactType" TEXT NOT NULL,
  "path" TEXT,
  "contentHash" TEXT,
  "redactionJson" TEXT,
  "expiresAt" DATETIME,
  "artifactJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TraceArtifact_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReplayIRCertification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "replayIrHash" TEXT,
  "actionEvidenceHash" TEXT,
  "certificationStatus" TEXT NOT NULL DEFAULT 'uncertified',
  "certificationFindings" TEXT,
  "certifiedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReplayIRCertification_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "EvidenceCompletenessLedger" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "plannedExecutableStepCount" INTEGER NOT NULL DEFAULT 0,
  "actionEvidenceCount" INTEGER NOT NULL DEFAULT 0,
  "replayIrActionCount" INTEGER NOT NULL DEFAULT 0,
  "compiledActionCount" INTEGER NOT NULL DEFAULT 0,
  "generatedMethodCount" INTEGER NOT NULL DEFAULT 0,
  "validatedActionCount" INTEGER NOT NULL DEFAULT 0,
  "plannedAssertionCount" INTEGER NOT NULL DEFAULT 0,
  "assertionEvidenceCount" INTEGER NOT NULL DEFAULT 0,
  "finalAssertionEvidenceCount" INTEGER NOT NULL DEFAULT 0,
  "missingEvidenceCount" INTEGER NOT NULL DEFAULT 0,
  "manualGateCount" INTEGER NOT NULL DEFAULT 0,
  "ledgerJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceCompletenessLedger_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "NavigationEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runResultId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "sequenceIndex" INTEGER NOT NULL,
  "contractStepId" TEXT,
  "requestedUrl" TEXT,
  "resolvedUrl" TEXT,
  "redirectChainJson" TEXT,
  "allowedOriginProof" TEXT,
  "loadStateProof" TEXT,
  "postNavigationOracleJson" TEXT,
  "evidenceJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NavigationEvidence_runResultId_fkey" FOREIGN KEY ("runResultId") REFERENCES "RunResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LocatorRecipe_runResultId_idx" ON "LocatorRecipe"("runResultId");
CREATE INDEX "LocatorRecipe_testCaseId_idx" ON "LocatorRecipe"("testCaseId");

CREATE INDEX "ActionEvidence_runResultId_idx" ON "ActionEvidence"("runResultId");
CREATE INDEX "ActionEvidence_testCaseId_idx" ON "ActionEvidence"("testCaseId");
CREATE INDEX "ActionEvidence_runResultId_sequenceIndex_idx" ON "ActionEvidence"("runResultId", "sequenceIndex");

CREATE INDEX "AssertionEvidence_runResultId_idx" ON "AssertionEvidence"("runResultId");
CREATE INDEX "AssertionEvidence_testCaseId_idx" ON "AssertionEvidence"("testCaseId");
CREATE INDEX "AssertionEvidence_assertionId_idx" ON "AssertionEvidence"("assertionId");

CREATE INDEX "AuthSetupEvidence_runResultId_idx" ON "AuthSetupEvidence"("runResultId");
CREATE INDEX "AuthSetupEvidence_testCaseId_idx" ON "AuthSetupEvidence"("testCaseId");
CREATE INDEX "AuthSetupEvidence_authProfileId_idx" ON "AuthSetupEvidence"("authProfileId");

CREATE INDEX "TraceArtifact_runResultId_idx" ON "TraceArtifact"("runResultId");
CREATE INDEX "TraceArtifact_testCaseId_idx" ON "TraceArtifact"("testCaseId");
CREATE INDEX "TraceArtifact_artifactType_idx" ON "TraceArtifact"("artifactType");

CREATE INDEX "ReplayIRCertification_runResultId_idx" ON "ReplayIRCertification"("runResultId");
CREATE INDEX "ReplayIRCertification_testCaseId_idx" ON "ReplayIRCertification"("testCaseId");
CREATE INDEX "ReplayIRCertification_certificationStatus_idx" ON "ReplayIRCertification"("certificationStatus");

CREATE INDEX "EvidenceCompletenessLedger_runResultId_idx" ON "EvidenceCompletenessLedger"("runResultId");
CREATE INDEX "EvidenceCompletenessLedger_testCaseId_idx" ON "EvidenceCompletenessLedger"("testCaseId");

CREATE INDEX "NavigationEvidence_runResultId_idx" ON "NavigationEvidence"("runResultId");
CREATE INDEX "NavigationEvidence_testCaseId_idx" ON "NavigationEvidence"("testCaseId");
CREATE INDEX "NavigationEvidence_runResultId_sequenceIndex_idx" ON "NavigationEvidence"("runResultId", "sequenceIndex");
