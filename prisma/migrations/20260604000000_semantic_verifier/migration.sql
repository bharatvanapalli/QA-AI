-- Semantic verifier additions (additive, SQLite-safe).
--
-- Project.assertionEquivalences: project-scoped synonym map fed to the
-- deterministic verifier so substring matching handles SUT-specific
-- text variations ("A to Z" ↔ "A-Z", "Thank you for your order!" ↔
-- "confirmation page"). Editable from Settings → Claude, OR auto-saved
-- after a semantic-fallback rerun rescues a case.
ALTER TABLE "Project" ADD COLUMN "assertionEquivalences" TEXT;

-- Run.verifierMode: per-run flag controlling whether _checkAssertionOnce
-- falls back to an LLM-mediated semantic check on a deterministic miss.
-- Default 'deterministic' preserves cost/latency for full-suite runs.
-- 'semantic_fallback' is set by the Blocked page "Rerun with AI
-- verification" endpoint.
ALTER TABLE "Run" ADD COLUMN "verifierMode" TEXT NOT NULL DEFAULT 'deterministic';
