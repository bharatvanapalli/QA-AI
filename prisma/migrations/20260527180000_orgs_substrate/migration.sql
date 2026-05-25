-- Phase E8 — Multi-tenancy substrate.
--
-- Adds the Organization tenancy boundary and tags Project / Secret /
-- Integration / WebhookConfig / NotificationChannel / AuditLog with an
-- `orgId`. Backfill creates one "Solo" Organization per existing User,
-- assigns the User as owner via OrgMembership, sets User.currentOrgId,
-- and tags every owned row with the resulting orgId.
--
-- All new orgId columns are NULLABLE so this migration is idempotent and
-- legacy rows (deleted users, orphan records) stay valid. The
-- requireOrg middleware enforces non-null on all NEW writes from the
-- application layer.

-- ── 1. New tables ──────────────────────────────────────────────

CREATE TABLE "Organization" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "ownerId"   TEXT NOT NULL,
    "plan"      TEXT NOT NULL DEFAULT 'solo',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Organization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_ownerId_idx" ON "Organization"("ownerId");

CREATE TABLE "OrgMembership" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "orgId"     TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "role"      TEXT NOT NULL DEFAULT 'member',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrgMembership_orgId_fkey"  FOREIGN KEY ("orgId")  REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id")         ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrgMembership_orgId_userId_key" ON "OrgMembership"("orgId", "userId");
CREATE INDEX "OrgMembership_userId_idx" ON "OrgMembership"("userId");

CREATE TABLE "OrgInvite" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "orgId"      TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "role"       TEXT NOT NULL DEFAULT 'member',
    "token"      TEXT NOT NULL,
    "invitedBy"  TEXT NOT NULL,
    "expiresAt"  DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrgInvite_orgId_fkey"     FOREIGN KEY ("orgId")     REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrgInvite_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "User"("id")         ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrgInvite_token_key" ON "OrgInvite"("token");
CREATE INDEX "OrgInvite_orgId_idx" ON "OrgInvite"("orgId");
CREATE INDEX "OrgInvite_email_idx" ON "OrgInvite"("email");

-- ── 2. Add orgId columns to existing tables ──────────────────

ALTER TABLE "User"                ADD COLUMN "currentOrgId" TEXT;
ALTER TABLE "Project"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "Secret"              ADD COLUMN "orgId" TEXT;
ALTER TABLE "Integration"         ADD COLUMN "orgId" TEXT;
ALTER TABLE "WebhookConfig"       ADD COLUMN "orgId" TEXT;
ALTER TABLE "NotificationChannel" ADD COLUMN "orgId" TEXT;
ALTER TABLE "AuditLog"            ADD COLUMN "orgId" TEXT;

-- ── 3. Backfill: one Solo org per existing user ──────────────
--
-- SQLite limitation: no procedural language inside a migration file.
-- We use INSERT ... SELECT with deterministic UUID generation via
-- random_blob/hex so each User gets a stable org row in this single pass.
-- The Org id is derived from User.id (prefixed) so re-running this
-- migration is idempotent under prisma's "applied-once" guarantee.

-- 3a. Create one Org per User. Slug is derived from email's local part.
INSERT INTO "Organization" ("id", "name", "slug", "ownerId", "plan", "createdAt", "updatedAt")
SELECT
    'org-' || u."id",
    COALESCE(NULLIF(u."organisation", ''),
             COALESCE(u."firstName", '') || COALESCE(' ' || u."lastName", ''),
             u."email") || '''s Workspace',
    -- slug: email local part + first 8 of user id, lowercase, alphanumeric-ish.
    -- Collisions across users with the same email local-part are made unique
    -- via the userId suffix.
    LOWER(SUBSTR(REPLACE(REPLACE(u."email", '.', '-'), '@', '-'), 1, 32))
        || '-'
        || SUBSTR(u."id", 1, 8),
    u."id",
    'solo',
    u."createdAt",
    u."updatedAt"
FROM "User" u;

-- 3b. Owner membership for each Org.
INSERT INTO "OrgMembership" ("id", "orgId", "userId", "role", "createdAt")
SELECT
    'mem-' || u."id",
    'org-' || u."id",
    u."id",
    'owner',
    u."createdAt"
FROM "User" u;

-- 3c. Set User.currentOrgId to their owned Org.
UPDATE "User" SET "currentOrgId" = 'org-' || "id";

-- 3d. Tag the per-user owned rows.
UPDATE "Project"             SET "orgId" = 'org-' || "userId" WHERE "userId" IS NOT NULL AND "orgId" IS NULL;
UPDATE "Secret"              SET "orgId" = 'org-' || "userId" WHERE "userId" IS NOT NULL AND "orgId" IS NULL;
UPDATE "Integration"         SET "orgId" = 'org-' || "userId" WHERE "userId" IS NOT NULL AND "orgId" IS NULL;
UPDATE "WebhookConfig"       SET "orgId" = 'org-' || "userId" WHERE "userId" IS NOT NULL AND "orgId" IS NULL;
UPDATE "NotificationChannel" SET "orgId" = 'org-' || "userId" WHERE "userId" IS NOT NULL AND "orgId" IS NULL;
UPDATE "AuditLog"            SET "orgId" = 'org-' || "userId" WHERE "userId" IS NOT NULL AND "orgId" IS NULL;

-- ── 4. Indices ───────────────────────────────────────────────

CREATE INDEX "Project_orgId_idx"             ON "Project"("orgId");
CREATE INDEX "Secret_orgId_idx"              ON "Secret"("orgId");
CREATE INDEX "Integration_orgId_idx"         ON "Integration"("orgId");
CREATE INDEX "WebhookConfig_orgId_idx"       ON "WebhookConfig"("orgId");
CREATE INDEX "NotificationChannel_orgId_idx" ON "NotificationChannel"("orgId");
CREATE INDEX "AuditLog_orgId_createdAt_idx"  ON "AuditLog"("orgId", "createdAt");
