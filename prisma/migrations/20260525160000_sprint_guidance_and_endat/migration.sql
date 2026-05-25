-- Phase B+ / M6: per-sprint operator guidance + planned end date.
-- Both nullable so legacy sprints stay valid and pre-M6 routes keep working.

ALTER TABLE "Sprint" ADD COLUMN "aiGuidance"    TEXT;
ALTER TABLE "Sprint" ADD COLUMN "expectedEndAt" DATETIME;
