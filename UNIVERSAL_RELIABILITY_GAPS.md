# Universal Scenario-Generation Reliability — Verified Gap Audit

Audit date: 2026-06-23. Method: 8 parallel grounded readers over the generation pipeline → one adversarial verifier per claimed gap (read the real code, confirm/refute). Project: OrangeHRM auth (465f2d08), but findings are pipeline-generic.

**Trust:** 8/8 subsystems; 46 gaps claimed; 42 independently verified (4 stragglers stopped, unverified); **36 confirmed real, 6 refuted/downgraded.** 0 blocker · 7 high · 19 medium · 10 low. Verifiers cited exact file:line and corrected finder path errors → trustworthy.

**Meta-finding:** the pipeline is reliable inside a validated lane (English docs · form-login sites · clean single-header Excel · auth/RBAC/CRUD domains) and **silently degrades** outside it (no error/warning). Silent degradation is the primary blocker to universal reliability.

---

## HIGH severity (break universality)

1. **No deterministic scenario floor.** `minScenarios` is prompt-only; no post-parse Node enforcement (architect.js — grep minScenarios: prompt + 1 destructure + 2 logs only). The 2026-06-23 prompt fix improved first-shot compliance but did NOT add a structural floor. Fix: after parse, if automationScenarios < minScenarios AND uncovered testable clauses remain, deterministic top-up call.
2. **Budget trusted from model self-report.** C/minScenarios/maxScenarios destructured from the model's own sourceIndex (architect.js ~2202-2204); Node never recomputes against the clause count it holds. Fix: recompute/clamp C from requirementClauses.length server-side.
3. **No sampling temperature pinned** — API default (1.0) on both streaming (architect.js ~1820-1828) and non-stream (~1855-1875) paths. Direct cause of run-to-run scenario-count variance. Fix: set temperature ~0.2-0.4 for authoring determinism.
4. **max_tokens=48000 truncation → silent partial.** stop_reason==='max_tokens' only logs a warn then proceeds to salvage-parse (architect.js ~1895-1902). Fix: treat truncation as a coverage failure / continue-generation, not a salvage.
5. **Module-scoped RTM traces against the FULL clause set.** scopedClauses is narrowed for the architect but the RTM denominator stays full-project (scenarios.js ~779-790) → every out-of-module clause reports uncovered on a scoped run (the PRIMARY "module is the unit of work" workflow). Fix: scope the RTM denominator to the same clause set the architect saw.
6. **Auth crawl = same-origin single-page username+password form login only** (calibrator.js attemptFormLogin ~251-310). OAuth/SSO/MFA/identity-first → authenticated app unmapped. Fix: pluggable auth strategies + honest "auth-unmapped" signal to the architect.
7. **Atlas vocabulary collapses on poor-ARIA SPAs** — extractElements is a11y-snapshot-bound (INTERACTIVE_ROLES, requires role+name) with no DOM-eval fallback (calibrator.js ~116-144, mcp.js ~4733-4790). Fix: DOM-structural excavation fallback when ARIA yields little.

## MEDIUM severity

8. Header-row detection hardcoded to row 0 (testData.js matrixToSheet ~124) — banner/multi-row/header-less sheets mis-parsed.
9. Cross-sheet join knows ONLY the auth-companion pattern (testDataMatrix.js buildCredentialJoin 203-227) — no general foreign-key/lookup-table relationships (e-commerce/banking/ERP normalized data).
10. Non-Latin-script test-data headers silently dropped (testDataUnderstanding.js norm ~56-58 collapses CJK/Cyrillic/Arabic to ''). ASCII non-English survives.
11. deterministicSplit over-admits (line-based, bullet branch, will/can modals, no sentence segmentation, no cap) on DLP-denied / LLM-timeout / no-key paths (requirementOracle.js 183-194).
12. Requirement de-dup is content-hash only, salted by sourceType (requirementOracle.js computeRequirementId 51-55) — cross-source restatements never merge → inflated clause count.
13. RTM/architect clause-set mismatch produces permanently-uncoverable misleading uncovered-counts (requirementOracle.js 228-244 no cap vs capped architect view).
14. No testability/structural filter — headings/preambles/TOC become first-class clauses (requirementOracle.js LLM filter ~271-274 only checks non-empty excerpt). [matches hand-found oracle over-extraction]
15. RTM coverage denominator has no testability filter → uncovered% overstates (requirementOracle.js buildRTM 146-177). Advisory/non-blocking.
16. Calibrator silently degrades on unreachable/blocked sites; persists bot-challenge pages as atlas vocabulary (scenarios.js ~722-727).
17. Architect Claude streaming path bypasses circuit-breaker AND budget wrapper (architect.js ~1817-1853 uses raw Anthropic client).
18. Gemini self-retries 429s in-process ~10 min (gemini.js 154-187) + model-string-keyed thinking-budget heuristic → reliability not provider-symmetric.
19. Scanned/image-only PDFs → empty text, dropped with soft warning; no OCR (docs.js isPdf ~120-134).
20. Atlas BFS discovers pages only via <a href> (calibrator.js ~693-714) — pushState-router SPAs / button-nav yield a 1-2 page atlas → starves multi-page TEXT grounding.
21. Non-whitelisted formats (.doc/.rtf/.odt/.pptx/images) → readAsText → binary mojibake persisted as a requirement (RunSuite.jsx ~410-411 only base64s pdf/docx).
22. Per-row/per-sheet coverage not tracked — binding 1-of-N rows counts as fully covered (coveragePlanner.js ~332-356).
23. Requirement pipeline truncates silently at 200K extract / 32K row / 60K join (docs.js MAX_TEXT=200000 etc.).
24. Coverage scoring & row-class detection hardwired to English stop-words/keyword sets + ASCII tokenization (coveragePlanner.js 23-30, 49-56).
25. DOCX tables/headers/footers/images lost — extraction uses mammoth.extractRawText, no table-aware path (docs.js ~144-149).

## LOW severity (real but narrow / mitigated)

26. SEEDED_MODULES OrangeHRM-shaped (moduleIntelligence.js 47-91) — but token/sheet-name fallback prevents data loss.
27. Short-text value-semantics assumption confined to literal-leak repair safety net (testDataAuthoring.js 169, 241), not the primary path.
28. Text grounding substring match lacks Unicode/typographic normalization; English-only reachability/title guards no-op on non-English (architect.js markUngroundedText ~2451, _normForGrounding ~2370).
29. Login-field discovery English-only NAME regexes, but positional fallback authenticates standard 2-field forms (calibrator.js ~268-273).
30. requirementRefs RTM fed from in-memory source can diverge from persisted column under a pre-migration Prisma client (scenarios.js ~970, testCaseContract.js 291-303).
31. Mid-generation persist non-transactional — process death → orphaned partial generation, no reaper for it (scenarios.js 933-973, no $transaction).
32. Calibration crawl inherits Conductor local-laptop browser topology (headed default, --no-sandbox, TLS bypass, userId-only session key) — non-portable to hosted multi-tenant (mcp.js ~589-590).
33. Unsupported binary test-data (.numbers, mistyped) → garbage CSV parse instead of rejection (testData.js ~206, 59-67).
34. Transactional/non-RBAC sheets get generic purpose label + miss additive module bonus, but data+binding preserved (testDataUnderstanding.js).
35. PII auto-detect hardcodes US/India formats + English keywords; unrecognized-locale PII → 'synthetic', lands inline (clear) in persisted ReplayIR (testDataUnderstanding.js detectSensitivity ~202-211).
36. (data-binding, hand-found) No execution-time unresolved-token gate; default-credential join uses first companion row; String() coercion of typed cells; no data-mutation isolation for CRUD matrices (testDataMatrix.js).

## REFUTED / downgraded (verifier killed these — do NOT fix)

- classifyPurpose catch-all to scenario_data is advisory/benign (real limitation is INPUT_ROLE_RE, mis-attributed).
- Clause-id brittleness orphaning dispositions — mechanically true but not the claimed impact.
- only-data/only-clauses/neither asymmetry — grounding handles it.
- "Long generation holds SQLite write lock" — FALSE; WAL + busy_timeout prevent it.
- Superseding-generation abort — intentional and signal-wired, not a bug.
- coveragePlanner "never closes gaps" — DELIBERATE design (synthesis removed on purpose), not a gap.

## Bottom line for "move to next"
Not perfect for universal use. It IS reliable in the validated lane (English + form-login + clean Excel + auth/RBAC) — v22 proved that. Whether the HIGH gaps block YOU depends on the target sites/docs you actually care about. Recommended first hardening (all generic): deterministic scenario floor + budget recompute (#1,#2), pin temperature (#3), scope RTM denominator (#5), and an "ingestion/auth/atlas degraded — output is partial" honest-signal layer to kill the silent-degradation meta-problem.
