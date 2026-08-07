# QAAI ReplayIR export (Playwright POM)

Generated ONLY from each RunResult's pinned replayIrJson — no AI-written code, no case-text regen.

**3-layer structure:**
- `locators/` — action-time locators (exact evidence from live MCP run)
- `pages/` — action-method classes (1:1 with recorded acts)
- `tests/` — journey specs calling page methods (zero inline selectors)

1. `npm install`
2. Copy `.env.example` to `.env` and fill required variables.
3. `npx playwright test`

To customize a locator: copy the entry from `locators/generated/` to `locators/overrides/` (override takes precedence; marked non-certified in EXPORT_MANIFEST.json).


**Test data:**
`tests/data/*.xlsx` is the human-readable master workbook exported from the uploaded dataset.
`tests/data/*.csv` files are sheet-level fallbacks for tools that prefer plain text.
Per-case `*.json` files are the row slices the generated specs actually execute.
