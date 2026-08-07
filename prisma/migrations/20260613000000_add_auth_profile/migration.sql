-- Enterprise Mode P4b — first-class auth-profile identity.
-- Additive only: one new table + one nullable column, so existing rows (the
-- preserved trial-run history) are untouched. Hand-authored + applied via
-- `prisma migrate deploy` (see memory: prisma-migration-gotcha).

-- A declared business identity (admin/demo/maker/checker/…) with an auth strategy
-- + disposition; optionally references an AuthFixture (storageState) or a named
-- credential. AuthProfile.id is the authProfileId used in the atlas slice key.
CREATE TABLE "AuthProfile" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "projectId"     TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "strategy"      TEXT NOT NULL DEFAULT 'form',
    "disposition"   TEXT NOT NULL DEFAULT 'bypass_fixture',
    "authFixtureId" TEXT,
    "credentialRef" TEXT,
    "environment"   TEXT NOT NULL DEFAULT 'default',
    "notes"         TEXT,
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     DATETIME NOT NULL,
    CONSTRAINT "AuthProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuthProfile_projectId_idx" ON "AuthProfile"("projectId");
CREATE UNIQUE INDEX "AuthProfile_projectId_name_key" ON "AuthProfile"("projectId", "name");

-- The case's declared identity (null = legacy default-fixture behavior).
ALTER TABLE "TestCase" ADD COLUMN "authProfile" TEXT;
