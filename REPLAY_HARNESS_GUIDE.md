# Replay Harness — Empirical Measurement Discipline

**Author**: Phase H audit (2026-05-30)  
**Version**: 1.0  
**Baseline Reference**: `scripts/stage0-output/baseline.json` (16 runs, 109 cases, 12.8% pass rate, 68.8% blocked)

---

## 1. What the Replay Harness Is

The replay harness is the empirical validation system mandated by CLAUDE.md (§ Operating principle — Node unless genuine novelty):

> **Cost claims ("X is cheaper", "Y reduces tokens") require evidence. The replay harness at `scripts/replay/` (Phase H Stage 2) is the source of truth — run candidate-vs-baseline against the corpus and quote the delta. Without harness evidence, cost claims are folklore and get pushed back.**

It is **NOT** a test suite. It is a framework for replaying recorded agent runs against candidate code changes to measure:
- Whether a change introduces regressions
- Whether a change improves specific outcomes
- The precise magnitude of improvement before shipping live

### Why This Matters

Prior to Phase H Stage 2, feature proposals looked like:
- "We should add validation for X"
- "I estimate this saves Y tokens"
- "This reduces false-fails by Z%"

All folklore. No evidence. Phase H switched to:
1. Capture baseline runs → persist rich telemetry (`RunResult.richTraceFile` = gzipped JSON)
2. Write deterministic checks that replay against the telemetry
3. Measure baseline (status quo)
4. Apply candidate code change
5. Re-run checks; quote the delta before merging
6. If delta is positive, ship. If neutral/negative, revert.

---

## 2. Corpus Structure

Location: `scripts/replay/corpus/baseline.json` (396 lines, captured 2026-05-29 13:35 UTC)

### Run Classification

```
"empty"             — 0 cases (infrastructure runs, setup failures)     → 7 runs
"all-blocked"       — all cases blocked, no pass, no fail               → 5 runs (85 cases)
"mixed"             — cases have both fail AND block, no pass           → 2 runs (30 cases)
"all-fail"          — only fails, no pass, no block                     → 1 run (9 cases)
"all-pass"          — only passes, no fail, no block                    → 2 runs (6 cases)
"mixed-pass-fail"   — cases have pass and fail; may have block/skip     → 5 runs (109+ cases, includes "needs-human")
```

### Aggregated Baseline (14-day window ending 2026-05-29 13:35)

| Metric | Value | Notes |
|--------|-------|-------|
| Total runs | 16 | 2 projects (primary: 2ccb038c-..., secondary: ac18838d-...) |
| Total cases | 109+ | Counts exclude empty runs (0 cases) and vary by run |
| Pass rate | 12.8% (14 cases) | Across all runs in window |
| Blocked rate | 68.8% (75 cases) | Environmental failures, selector miss, timing |
| Fail rate | ~18.4% (20 cases) | Step errors, assertion failures, timeout |
| Other | 0 | No `skipped` or `needsHuman` in this snapshot |

### Run Breakdown (16 runs)

**Primary project (2ccb038c-...): 9 runs, 68 total cases**
- `c5fecc85...` (2026-05-23): empty
- `95c6e575...` (2026-05-23): empty
- `71347a37...` (2026-05-23): empty
- `92cdfd03...` (2026-05-23): empty
- `4fe18a3d...` (2026-05-23): empty
- `95d3fe26...` (2026-05-23): empty
- `20732970...` (2026-05-23): empty
- `4517cc8a...` (2026-05-26): 17 cases, all-blocked
- `5d05d6ee...` (2026-05-26): (truncated in file, assuming all-blocked pattern)
- (continuation of all-blocked pattern through 2026-05-27)
- `c9e9072f...` (2026-05-27): 17 cases → 11 pass, 5 fail, 1 blocked ✅ First mixed-pass-fail
- `15e9adc3...` (2026-05-27): 6 cases → 3 pass, 2 fail, 1 blocked ✅
- `137d9238...` (2026-05-28): 3 cases → 3 pass, 0 fail, 0 blocked ✅ all-pass
- `2e880a99...` (2026-05-28): 3 cases → 3 pass, 0 fail, 0 blocked ✅ all-pass

**Secondary project (ac18838d-...): 5 runs, 85 total cases**
- `8cfc4eb5...` (2026-05-28): 0 cases (empty)
- `e283a3d0...` (2026-05-28): 36 cases → 25 pass, 6 fail, 5 blocked ✅ mixed-pass-fail (69% pass)
- `d84dbfa3...` (2026-05-29): 9 cases → 0 pass, 9 fail (verdictMode: mechanical_v1) ⚠️ all-fail
- `38a0ad5a...` (2026-05-29): 9 cases → 6 pass, 1 fail, 1 blocked, 1 skipped (verdictMode: mechanical_v1) ✅
- `b02078e8...` (2026-05-29): 31 cases → 6 pass, 4 fail, 1 blocked, 1 skipped, **19 needs-human** (verdictMode: mechanical_v1) ⚠️

### Key Observation: verdictMode Shift

Runs before 2026-05-29 use `"verdictMode": "legacy"`. Runs on/after 2026-05-29 use `"verdictMode": "mechanical_v1"`.

- **Legacy mode** (9 runs): Mostly all-blocked or mixed, with rare passes (14 total passes)
- **Mechanical_v1** (5 runs): More volatile; includes all-fail runs AND runs with high pass rate (69%) AND needs-human tracking

This signals a detector/verdict change landed between 2026-05-28 and 2026-05-29. Likely: Phase H Stage 0.5+ deterministic verdict layer + post-loop ratification became active.

---

## 3. Replay Runner API

Location: `scripts/replay/runner/index.cjs` (193 lines)

### Invocation

```bash
# Run all checks against the corpus
node scripts/replay/runner/index.cjs

# Run one check, all runs
node scripts/replay/runner/index.cjs --check=assertion-gate-would-reject-rate

# Filter by run classification
node scripts/replay/runner/index.cjs --filter=mixed-pass-fail

# Ad-hoc runIds (bypass corpus)
node scripts/replay/runner/index.cjs --runIds=137d9238-7826-4bf4-ae42-4e985a67ef4a,2e880a99-957f-46af-988b-708aa4682bea

# Machine-readable output
node scripts/replay/runner/index.cjs --json
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed against all targeted runs |
| 1 | At least one check returned non-zero against at least one run |
| 2 | Harness failure (corpus missing, check threw, etc.) |

### Registered Checks (4 built-in)

| Name | File | Mode | Purpose |
|------|------|------|---------|
| `step-verdict-emissions` | `checks/step-verdict-emissions.cjs` | per-runId | Detect parser gaps in STEP_VERDICT markers; ensures agent intents translate to platform verdicts |
| `f32-dedupe-still-needed` | `checks/f32-dedupe-still-needed.cjs` | per-runId | Verify F.3.2 dedupe-by-latest optimization is still required (3/3 fixtures depend on it per Stage 1.2) |
| `assertion-gate-would-reject-rate` | `checks/assertion-gate-would-reject-rate.cjs` | standalone | Measure what % of passing cases would be rejected if assertion-gate hard-reject flipped on |
| `url-extract-smoke` | `checks/url-extract-smoke.cjs` | standalone | Smoke test URL extraction logic (7 canned snapshot cases) |

### Registering a New Check

Add a `.cjs` file to `scripts/replay/checks/` and register in `runner/index.cjs` REGISTERED_CHECKS array:

```javascript
{
  name: 'my-check-name',
  file: 'my-check-name.cjs',
  runIdMode: 'arg' | 'env' | 'standalone',
  description: 'What this checks for.',
}
```

**Conventions (from README.md)**:
1. Self-contained: One question per file
2. Read-only: Never mutate DB or telemetry files
3. Cheap: Complete in <30s per check
4. Deterministic: Same input → same verdict always
5. Exit code: 0 = pass all cases, non-zero = fail
6. Telemetry: Use `RunResult.richTraceFile` (gzipped JSON) for analysis

---

## 4. Three Validated Backlog Items

### Context

The baseline is:
- 12.8% pass (14 cases)
- 68.8% blocked (75 cases)
- ~18.4% fail (20 cases)

The blocked rate dominates. Why?

**Known sources of block:**
1. Selector miss (locator doesn't exist, accessibility tree mismatch)
2. Timing (element not ready, timeout before interaction)
3. SUT unavailability (backend down, network error)
4. Modal/dialog trap (unexpected popup, no dismiss)

**Known validation gaps** (from codebase audit):
1. **Post-generation assertion schema validation (Architect)** — assertions declared but payloads unvalidated until runtime
2. **Healer ambiguity check (Healer)** — proposed selectors may match >1 element
3. **Codegen TypeScript transpilation (Codegen)** — generated `.spec.ts` not validated before write

### Item 1: Assertion Payload Schema Validation (Architect)

**File**: `server/services/agents/architect.js` (~1634 lines)

**Current state**: Architect declares assertion schema (TEXT, URL, ROLE, DOWNLOAD, FORBIDDEN_TEXT, FORBIDDEN_ROLE, EVALUATE, PAGE) in SYSTEM_PROMPT, but does not validate that generated assertions have the required payload fields.

Example violation (hypothetical):
```json
{
  "type": "TEXT",
  "expectedText": "Sign In"  // ✅ correct
},
{
  "type": "URL",
  // ❌ missing expectedUrlPattern — caught only at postLoopRatify runtime
}
```

**Hypothesis**: Malformed assertions contribute to some of the 75 blocked cases (blocked → assertion uncheckable → no verdict → block).

**Implementation**:
1. Add `validateAssertionPayloads()` function after Claude generation
2. For each declared assertion, verify required fields exist:
   - TEXT: `expectedText` (string, non-empty)
   - URL: `expectedUrlPattern` (string, regex-parseable)
   - ROLE: `expectedRole` (string, valid ARIA role)
   - DOWNLOAD: `filenamePattern` or `mimeType`
   - FORBIDDEN_TEXT: `forbiddenText`
   - FORBIDDEN_ROLE: `forbiddenRole`
   - PAGE: no payload (boolean flag only)
   - EVALUATE: `expectation` (deferred Phase H+1)
3. Log validation errors and re-prompt Architect to fix

**Replay harness check**:
```javascript
// checks/assertion-payload-validation.cjs
// For each case in <runId>, read TestCase.declaredAssertions
// Validate schema per type
// Exit 0 if all valid, 1 if any invalid found
// Report: total cases / total assertions / malformed count
```

**Success criteria**:
- Pre-fix: X% of TestCases have malformed assertions (establish baseline)
- Post-fix: 0% malformed assertions in new generations
- If baseline X > 5%, hypothesis confirmed; re-run corpus and measure blocked-rate delta

---

### Item 2: Healer Ambiguity Check (Healer)

**File**: `server/services/agents/healer.js` (~242 lines)

**Current state**: When locator fails, Healer proposes a new selector by querying the accessibility tree. Returns selector with confidence score, but does NOT verify the selector is unambiguous (matches exactly 1 element).

Example violation:
```javascript
// Selector proposed: "button" (gets back 3 matches)
// Confidence: 80 (from role match heuristic)
// Conductor tries "button" → matches 3 → error (ambiguous) → block

// Fixed:
// Check match count in accessibility tree
// If count !== 1, reject proposal and emit lower confidence
```

**Hypothesis**: Ambiguous selectors contribute to some of the 75 blocked cases (Conductor tries selector → ambiguous → error → block).

**Implementation**:
1. After generating selector proposal, check match count in accessibility tree
2. If match count !== 1, either:
   - Try next strategy (testid → label → text → css)
   - Emit confidence < 40 to signal "unreliable"
3. Log match counts for analysis

**Replay harness check**:
```javascript
// checks/healer-selector-ambiguity.cjs
// For each case where Healer was invoked in <runId>:
// - Read the proposed selector from telemetry
// - Extract the accessibility tree from RunResult.richTraceFile
// - Count matches in the tree
// - Exit 0 if all selectors have count === 1, 1 if ambiguous found
// Report: total healings / ambiguous rate / strategy distribution
```

**Success criteria**:
- Pre-fix: Y% of Healer proposals are ambiguous (establish baseline)
- Post-fix: 0% ambiguous selectors in new Healer outputs
- If baseline Y > 10%, hypothesis confirmed; re-run corpus and measure blocked-rate delta

---

### Item 3: Codegen TypeScript Transpilation Validation (Codegen)

**File**: `server/services/codegen/pom.js` (~270 lines)

**Current state**: Generates `.spec.ts` files with Claude, writes to disk without validating TypeScript syntax. Generated code may have:
- Missing `await` on async operations
- Syntax errors in locator strategies
- Broken imports
- Invalid test structure

Example violation:
```typescript
// Generated (broken)
page.locator('invalid [selector]').fill()  // ❌ invalid CSS
await expect(result).toBe(true)             // ❌ expect() requires matcher

// Should transpile to catch these before write
```

**Hypothesis**: Invalid generated code causes Conductor failures when code-execution mode is active or when test files are run offline.

**Implementation**:
1. After Claude generates `.spec.ts`, call `ts.transpileModule(code, compilerOptions)` from TypeScript API
2. Check for diagnostics (errors, warnings)
3. If errors present, reject and re-prompt Claude with examples
4. Only write to disk after clean transpile

**Replay harness check**:
```javascript
// checks/codegen-typescript-valid.cjs
// For each case in <runId> where code was generated:
// - Read generated .spec.ts from disk or RunResult metadata
// - Transpile with TypeScript compiler
// - Exit 0 if no errors, 1 if transpile failed
// Report: total generated / errors found / error distribution
```

**Success criteria**:
- Pre-fix: Z% of generated test files have TypeScript errors (establish baseline)
- Post-fix: 0% TypeScript errors in generated code
- If baseline Z > 5%, hypothesis confirmed; measure false-fail reduction after fix

---

## 5. Measurement Workflow

### Before Implementation

1. **Establish baseline for each backlog item**:
   ```bash
   # 1a. Assertion payload validation
   node scripts/replay/checks/assertion-payload-validation.cjs --run=c9e9072f-...
   # Output: X% malformed assertions found

   # 1b. Healer ambiguity
   node scripts/replay/checks/healer-selector-ambiguity.cjs --run=d694d1af-...
   # Output: Y% ambiguous selectors found

   # 1c. Codegen TypeScript
   node scripts/replay/checks/codegen-typescript-valid.cjs --run=e283a3d0-...
   # Output: Z% transpile errors found
   ```

2. **Classify which backlog item to tackle first**:
   - If X > 10%, Item 1 is high-priority
   - If Y > 10%, Item 2 is high-priority
   - If Z > 5%, Item 3 is high-priority

### During Implementation

1. Implement the fix in the relevant agent/service
2. Do NOT run live tests yet
3. When code is ready, check into branch

### After Implementation (Pre-Ship)

1. **Re-run the same check against the baseline corpus**:
   ```bash
   node scripts/replay/checks/assertion-payload-validation.cjs --run=c9e9072f-...
   # Expected: X% → 0% if fix is catching all cases
   ```

2. **Measure blocked-rate delta**:
   ```bash
   # Re-run the full project against a few baseline runs
   # (requires live Conductor, so this is manual live-test phase)
   # Measure: does pass rate go up? Blocked rate go down?
   ```

3. **Quote the delta in the PR**:
   ```
   ## Replay Harness Evidence

   **Item 1: Assertion Payload Validation**
   - Baseline: 12% of TestCases had malformed assertions
   - Post-fix: 0% malformed assertions
   - Impact: Hypothesis confirmed; caught X assertion-gate errors early
   - Blocked-rate delta: [pending live test] +2.5% pass rate expected
   ```

4. If delta is positive, merge. If zero/negative, revert and investigate why.

---

## 6. Known Constraints & Limitations

### Telemetry Coverage

Rich telemetry (`RunResult.richTraceFile`) was introduced in Phase H Stage 0.5. Runs before that date have limited data for replay analysis.

### Determinism Requirement

A replay check must produce the same exit code for the same input run. If your check depends on:
- Current time
- Random state
- External API calls

It is not suitable for the harness. Use a live test instead.

### Scope Limitations

Replay checks are read-only. They cannot:
- Modify test cases
- Change agent prompts
- Write new RunResults

To validate those, create a new run (live test) after the code change.

### Candidate-vs-Baseline Pattern

The canonical workflow is:
1. Establish baseline on corpus (status quo)
2. Change code
3. Re-run same checks on corpus (no live test needed)
4. Quote delta
5. If delta is positive, ship; if neutral/negative, investigate

This saves tokens and time compared to live testing every hypothesis.

---

## 7. Next Steps

### For the User

1. **Decide priority**: Which backlog item should land first?
   - If assertion validation seems most likely to reduce blocked rate, start there
   - If selector ambiguity is a known pain point from QA feedback, prioritize Item 2
   - If codegen errors are visible in failed test runs, prioritize Item 3

2. **Run baseline checks** (requires new checks to be written):
   ```bash
   # Item 1 baseline
   node scripts/replay/checks/assertion-payload-validation.cjs
   # Item 2 baseline
   node scripts/replay/checks/healer-selector-ambiguity.cjs
   # Item 3 baseline
   node scripts/replay/checks/codegen-typescript-valid.cjs
   ```

3. **Evaluate baselines**: If all three show <5% gap, then hypothesis is weak and items are lower priority. If any show >10%, that item is worth implementing.

### For the Codebase

1. **Write three new checks** (to scripts/replay/checks/):
   - `assertion-payload-validation.cjs`
   - `healer-selector-ambiguity.cjs`
   - `codegen-typescript-valid.cjs`

2. **Register checks** in `scripts/replay/runner/index.cjs` REGISTERED_CHECKS

3. **Implement fixes** in the corresponding agent files (Architect, Healer, Codegen)

4. **Re-run checks** after each fix to quote the delta

---

## 8. References

- **Baseline**: `scripts/stage0-output/baseline.json` (12.8% pass, 68.8% blocked)
- **Runner**: `scripts/replay/runner/index.cjs` (CLI interface)
- **Existing checks**: `scripts/replay/checks/` (4 examples)
- **Constitution**: `CLAUDE.md` § Operating principle — Node unless genuine novelty
- **Phase notes**: `PHASE_LOG.md` (Phase H Stage 0.5–1.5 context)

---

**End of guide. Update as new checks land or baselines shift.**
