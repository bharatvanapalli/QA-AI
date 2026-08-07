-- Enterprise Mode P9 — per-project all-or-nothing trust toggle.
-- Additive/default-off so existing trial projects and legacy export flows are unchanged
-- until a project explicitly enables Enterprise Mode.
ALTER TABLE "Project" ADD COLUMN "enterpriseMode" BOOLEAN NOT NULL DEFAULT false;
