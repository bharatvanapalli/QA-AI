-- Persist immutable authored occurrence identity as first-class evidence columns.
-- Additive only: existing JSON evidence remains authoritative and legacy rows stay valid.
-- `sequenceIndex` remains trail traversal order; `authoredSequenceIndex` is the
-- immutable authored-action sequence carried by the action identity contract.

ALTER TABLE "LocatorRecipe" ADD COLUMN "sourceContractStepId" TEXT;
ALTER TABLE "LocatorRecipe" ADD COLUMN "actionOccurrenceId" TEXT;
ALTER TABLE "LocatorRecipe" ADD COLUMN "sourceActionOccurrenceId" TEXT;
ALTER TABLE "LocatorRecipe" ADD COLUMN "authoredActionId" TEXT;
ALTER TABLE "LocatorRecipe" ADD COLUMN "authoredSequenceIndex" INTEGER;
ALTER TABLE "LocatorRecipe" ADD COLUMN "occurrenceOrdinal" INTEGER;
ALTER TABLE "LocatorRecipe" ADD COLUMN "occurrenceKey" TEXT;

ALTER TABLE "ActionEvidence" ADD COLUMN "sourceContractStepId" TEXT;
ALTER TABLE "ActionEvidence" ADD COLUMN "actionOccurrenceId" TEXT;
ALTER TABLE "ActionEvidence" ADD COLUMN "sourceActionOccurrenceId" TEXT;
ALTER TABLE "ActionEvidence" ADD COLUMN "authoredActionId" TEXT;
ALTER TABLE "ActionEvidence" ADD COLUMN "authoredSequenceIndex" INTEGER;
ALTER TABLE "ActionEvidence" ADD COLUMN "occurrenceOrdinal" INTEGER;
ALTER TABLE "ActionEvidence" ADD COLUMN "occurrenceKey" TEXT;

CREATE INDEX "LocatorRecipe_runResultId_testCaseId_actionOccurrenceId_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "actionOccurrenceId");
CREATE INDEX "LocatorRecipe_runResultId_testCaseId_sourceActionOccurrenceId_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "sourceActionOccurrenceId");
CREATE INDEX "LocatorRecipe_runResultId_testCaseId_authoredActionId_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "authoredActionId");
CREATE INDEX "LocatorRecipe_runResultId_testCaseId_occurrenceKey_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "occurrenceKey");
CREATE INDEX "LocatorRecipe_runResultId_testCaseId_contractStepId_occurrenceOrdinal_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "contractStepId", "occurrenceOrdinal");
CREATE INDEX "LocatorRecipe_runResultId_testCaseId_sourceContractStepId_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "sourceContractStepId");
CREATE INDEX "LocatorRecipe_runResultId_testCaseId_authoredSequenceIndex_idx"
  ON "LocatorRecipe"("runResultId", "testCaseId", "authoredSequenceIndex");

CREATE INDEX "ActionEvidence_runResultId_testCaseId_actionOccurrenceId_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "actionOccurrenceId");
CREATE INDEX "ActionEvidence_runResultId_testCaseId_sourceActionOccurrenceId_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "sourceActionOccurrenceId");
CREATE INDEX "ActionEvidence_runResultId_testCaseId_authoredActionId_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "authoredActionId");
CREATE INDEX "ActionEvidence_runResultId_testCaseId_occurrenceKey_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "occurrenceKey");
CREATE INDEX "ActionEvidence_runResultId_testCaseId_contractStepId_occurrenceOrdinal_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "contractStepId", "occurrenceOrdinal");
CREATE INDEX "ActionEvidence_runResultId_testCaseId_sourceContractStepId_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "sourceContractStepId");
CREATE INDEX "ActionEvidence_runResultId_testCaseId_authoredSequenceIndex_idx"
  ON "ActionEvidence"("runResultId", "testCaseId", "authoredSequenceIndex");
