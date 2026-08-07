-- Step 3B bridge — the case↔workbook storyId join key. Additive + nullable →
-- safe on a live DB; legacy rows + a pre-regen client keep working.
ALTER TABLE "RequirementClause" ADD COLUMN "storyId" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "storyId" TEXT;
