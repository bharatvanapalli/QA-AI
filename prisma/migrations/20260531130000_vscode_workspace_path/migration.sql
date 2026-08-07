-- "Open in VS Code" feature — additive only (SQLite-safe).
--
-- Project.vscodeWorkspacePath — absolute folder path on the operator's machine
-- where this project's generated suite is copied and opened via `code <path>`.
-- Nullable; existing projects are unaffected until the operator sets it.
ALTER TABLE "Project" ADD COLUMN "vscodeWorkspacePath" TEXT;
