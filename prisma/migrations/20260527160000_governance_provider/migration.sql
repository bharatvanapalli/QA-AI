-- Phase E7 — external Git provider PR push.
-- Pure additive. All columns nullable; existing GovernancePR rows stay valid
-- and only get populated when an operator clicks "Push to Git".

ALTER TABLE "GovernancePR" ADD COLUMN "providerPrNumber" TEXT;
ALTER TABLE "GovernancePR" ADD COLUMN "providerPrUrl"    TEXT;
ALTER TABLE "GovernancePR" ADD COLUMN "providerStatus"   TEXT;
ALTER TABLE "GovernancePR" ADD COLUMN "providerBranch"   TEXT;
ALTER TABLE "GovernancePR" ADD COLUMN "pushedAt"         DATETIME;
ALTER TABLE "GovernancePR" ADD COLUMN "pushedBy"         TEXT;
