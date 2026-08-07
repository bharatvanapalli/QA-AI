# QAAI ReplayIR export (Playwright)

Generated ONLY from each RunResult's pinned replayIrJson — no AI-written code, no case-text regen.

1. `npm install`
2. Set the variables in `.env.example` (see EXPORT_MANIFEST.json for the source run).
3. `npx playwright test`

**Verdict semantics:** EXPORT_MANIFEST.json records each test's `expectedVerdict`. A `fail` test is expected to hard-fail if the bug persists; a `blocked`/`needs_human` test is `describe.skip` (it cannot report green). Actual clean-env execution parity is verified separately (P8).
