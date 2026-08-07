-- Enterprise Mode P3 — role-aware, module-scoped, versioned atlas slices.
-- Additive only (ADD COLUMN nullable / with default). Preserves all existing
-- Calibration / CalibrationPage rows (legacy whole-app atlas = module NULL,
-- authProfileId NULL, version 1, isCurrent 1). Apply with `prisma migrate deploy`.

ALTER TABLE "Calibration" ADD COLUMN "module" TEXT;
ALTER TABLE "Calibration" ADD COLUMN "authProfileId" TEXT;
ALTER TABLE "Calibration" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Calibration" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Calibration" ADD COLUMN "atlasFingerprint" TEXT;
ALTER TABLE "Calibration" ADD COLUMN "staleAt" DATETIME;

ALTER TABLE "CalibrationPage" ADD COLUMN "capabilitiesJson" TEXT;

CREATE INDEX "Calibration_projectId_module_authProfileId_isCurrent_idx"
  ON "Calibration"("projectId", "module", "authProfileId", "isCurrent");
