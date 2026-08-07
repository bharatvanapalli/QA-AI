-- E4: Calibration models for the pre-run site crawl (Calibrator MVP)
CREATE TABLE "Calibration" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "projectId"    TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'running',
    "startUrl"     TEXT NOT NULL,
    "pagesCount"   INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"  DATETIME,
    CONSTRAINT "Calibration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CalibrationPage" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "calibrationId" TEXT NOT NULL,
    "url"           TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "pageRole"      TEXT,
    "elementsJson"  TEXT NOT NULL,
    "snapshotHash"  TEXT,
    "capturedAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalibrationPage_calibrationId_fkey" FOREIGN KEY ("calibrationId") REFERENCES "Calibration" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Calibration_projectId_idx" ON "Calibration"("projectId");
CREATE INDEX "CalibrationPage_calibrationId_idx" ON "CalibrationPage"("calibrationId");
