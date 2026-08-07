# QAAI — Site Atlas Calibration & Assertion Grounding (context for review)

*A brief for an architect friend. Goal: explain what we built, why, and where we'd genuinely value ideas. Written 2026‑06‑01.*

---

## 0. One‑paragraph framing

QAAI is an autonomous QA platform. You give it requirement docs (BRD / user stories) and a target web app; a chain of LLM agents **authors** test scenarios + cases, **executes** them in a real browser (Playwright via MCP), and emits a **mechanical verdict** (pass / fail / blocked / needs_human) per case plus a release GO/NO‑GO. The piece described here is a fix for a specific, trust‑destroying failure mode: the system kept flagging correct executions as `needs_human` because the *authored assertions* referenced UI text the app never actually shows.

---

## 1. The bug, precisely

A case like *"Navigate to Add Employee form and verify basic structure"* executed perfectly, but the verdict came back `needs_human`. Root cause: the **Architect** (the authoring LLM) had never *seen* the application — it writes assertions purely from the requirement documents. So it asserted, as a hard acceptance criterion, that the page shows the literal text **"Employee Name"**. The real OrangeHRM Add‑Employee form shows **"First Name / Middle Name / Last Name"**. The text wasn't there → the assertion came back `uncheckable` → and because no criticality tier was set it defaulted to `must` → the whole case hard‑escalated to `needs_human`.

The verdict layer was behaving *correctly* — it faithfully evaluated the contract it was handed. The defect was upstream, in authoring: **the Architect was hallucinating UI vocabulary.** Two flavors:
- **Pure fabrication** — text shown on no page anywhere.
- **Mis‑scoped real label** — text that exists in the app but not on the page this case targets (e.g. "Employee Name" is a real label on the *Employee List* search page, just not on the *Add* form).

A sibling failure mode in negative cases: *"login with empty password"* executed correctly (page showed "Required", stayed on /auth/login = correctly blocked), but the authored assertion expected the invented string **"Password cannot be empty"** as a `must`, plus an ungrounded URL assertion → `needs_human`. The agent's *runtime observation was right*; the *declared contract was wrong*.

---

## 2. The architecture (three layers, clean separation)

```
  Requirement docs ─┐
                    ▼
   ┌─────────────────────────────┐     ┌──────────────────────────┐
   │  ARCHITECT (LLM authoring)  │◄────│  SITE ATLAS (Calibrator) │  ← NEW grounding input
   │  scenarios + cases +        │     │  live crawl of the app   │
   │  declaredAssertions         │     └──────────────────────────┘
   └──────────────┬──────────────┘                 │
                  ▼                                 │ structured per-page text
   ┌─────────────────────────────┐                 ▼
   │  GROUNDING GATE (det., no LLM) │◄──────────────┘   ← NEW deterministic floor
   │  demote ungrounded TEXT asserts │
   └──────────────┬──────────────┘
                  ▼ persisted cases
   ┌─────────────────────────────┐
   │  CONDUCTOR (LLM + Playwright/MCP) │  executes, records assertion outcomes
   └──────────────┬──────────────┘
                  ▼
   ┌─────────────────────────────┐
   │  VERDICT LAYER (pure function) │  declared + recorded → pass/fail/blocked/needs_human
   └─────────────────────────────┘
```

Key principle we enforce: **the Atlas governs *HOW to interact* and *WHICH labels exist*, never *WHAT the business result should be*.** Documents remain the authority on intended outcomes; the live app is the authority on vocabulary. (This prevents the opposite failure — "automate the broken state as if it were the spec".)

---

## 3. The Calibrator (atlas crawling)

A pre‑run crawl that maps the app into a `Calibration` → many `CalibrationPage` rows `{ url, normalizedUrl, pageRole, elementsJson, textCorpus }`.

Pipeline (all via the same Playwright MCP we run tests with):
1. **Authenticate.** Most enterprise pages are behind login. The crawler logs in with form credentials *before* the crawl. Credentials come from the project store, or — our case — are **harvested from an existing test case's step values** (the Architect bakes `Fill Username = Admin / Fill Password = admin123` straight from the BRD, so we mine that).
2. **BFS crawl.** From the post‑login landing page, breadth‑first up to N pages (default 20–30).
3. **Per page, capture two things:**
   - **Interactive elements** (button / link / textbox / …) with a stability‑ranked selector chain (testid > role+name > placeholder > text > css). Used by the executor to target elements correctly on the *first* try (rerun speed).
   - **Visible text corpus** — every meaningful node's accessible name + placeholders (headings, labels, column headers, static copy). This is the ground truth a TEXT/PAGE assertion is checked against.
4. **Classify page role** — one cheap LLM call → "login page" / "employee list" / "dashboard" …
5. **Find links for the next BFS level** — see §6, this was non‑obvious.

Result on our reference app (OrangeHRM): **1 login‑only page → 29 authenticated pages** with real labels captured (Personal Details → "First Name | Middle Name | Last Name | Save", etc.).

The atlas is consumed two ways:
- **Architect (prevention):** the crawl's page list + each page's visible‑text labels are injected into the authoring prompt: *"author TEXT/PAGE assertions ONLY against strings that appear in a page's visible‑text list; do not invent labels."*
- **Grounding gate (deterministic floor):** see next.

---

## 4. The grounding gate (deterministic, no LLM)

After the Architect authors a case, a pure function checks each TEXT assertion against the atlas and **demotes** any whose expected text the calibrated target page doesn't actually show. "Demote" = mark `parseFailed: true, parseFailedReason: 'text_ungrounded'` — a state the verdict layer already understood: **parseFailed records are excluded from the verdict math** (they can't pass, fail, or escalate) but are still shown in the report *with the reason*, so nothing is hidden.

Conservatism is deliberate — we only demote with *evidence of absence*:
- assertion carries an explicit `targetUrl` resolving to a crawled page whose text lacks it → demote (highest confidence: the Architect's own page claim, checked against ground truth); **or**
- no usable target, the atlas is substantial (≥3 pages), and the text appears on **no** crawled page → demote (pure fabrication).
- Otherwise (thin atlas, target page not crawled, FORBIDDEN/absence assertions, a real‑but‑mis‑scoped label with no targetUrl) → **leave as‑is.** Absence of evidence is never treated as evidence of absence.

We deliberately do **not** scope a no‑targetUrl assertion to the case's step‑navigated pages, because an incomplete crawl would then false‑demote text that genuinely lives on an un‑crawled page. The mis‑scoped‑real‑label case is left to Architect *prevention* (it now sees the real labels), not the gate.

Verified deterministically (no live run): the exact failing case's inputs produce `needs_human(assertion_uncheckable)` **before** grounding and `pass` **after** — same inputs, no false escalation.

---

## 5. The verdict layer (for context)

A pure, LLM‑free priority ladder: termination signals → structural guard → execution failures (gated on whether verification completed) → **criticality‑tiered assertion outcomes** (`must` miss = fail / needs_human; `should`/`incidental` miss = warning on a still‑passing case) → termination cleanliness → pass. Default criticality is `must` (silence = hard requirement, so the Architect can't accidentally soften a real check). This is *why* an untiered hallucinated label was so destructive — and why the grounding gate (which removes it from the math entirely) is the right lever.

Related doctrine for negative cases: the `must` should be the **robust BLOCKED signal** (login form still present, asserted positively), the exact error string is `incidental` (inferred copy), and a regulated/quoted error code can be `must` only when the source explicitly mandates it.

---

## 6. Four non‑obvious things we hit (live‑validation war stories)

These are the kind of thing where outside eyes help:
1. **Credentials weren't in the credential store** — they live baked in test‑step values. Fix: harvest from steps.
2. **The MCP accessibility snapshot has no `href` attributes**, so the naïve "scan snapshot for links" found nothing → BFS never expanded. Fix: pull real anchors from the live DOM via `browser_evaluate('() => [...document.querySelectorAll("a[href]")].map(a => a.href)')`.
3. **A latent system‑wide bug:** our `browser_evaluate` result parser only matched the marker `"Result:"`, but this @playwright/mcp build labels returns `"### Result"` (markdown, no colon) → it returned null for *every* evaluate, silently. This very likely also degraded `browser_evaluate`‑backed *assertions* into `uncheckable`. Fixed at the root.
4. **Background‑job logs were WS‑only** (invisible if nobody's on the socket) → added a console mirror.

---

## 7. Open questions — where we'd love ideas

1. **Click‑reached pages.** Some pages (e.g. an "Add Employee" form opened by a tab/button, not an `<a href>`) never enter the BFS. Options we're weighing: (a) a bounded "click every role=link/menuitem/tab element and snapshot" pass — stateful and risky; (b) infer routes from the SPA's router config; (c) accept the gap and rely on Architect prevention. What would you do?
2. **Dynamic / post‑interaction states.** Validation copy like "Required" only appears *after* submitting an empty form — a static crawl can't capture it, so grounding can't verify negative‑case error strings. Is there a clean way to map "states" rather than "pages" without exploding the crawl?
3. **Declared‑contract vs runtime‑observation tension.** The verdict is computed from the *authored* assertion, not what the agent *saw*. When the agent correctly observes reality but the declared assertion is wrong, we currently down‑tier/drop the assertion. Should the executor be allowed to *propose a corrected assertion* (human‑approved) and feed it back into authoring? Where's the line before this becomes "the test grades itself"?
4. **Atlas staleness.** The app changes after the crawl. We store a snapshot hash per page. What's a good staleness policy — TTL, hash‑diff on next run, or only re‑crawl pages a run actually touched?
5. **Crawl budget vs coverage.** maxPages caps cost but misses depth. Is BFS the right strategy, or should we prioritize pages the *requirements* mention (requirement‑guided crawl)?
6. **Grounding beyond TEXT.** Today the gate only grounds TEXT assertions. PAGE assertions are multi‑signal (text + role + url) and already half‑weighted; ROLE/EVALUATE aren't grounded at all. Worth extending, or does the multi‑signal design already make PAGE robust enough?

---

## 8. TL;DR

We gave the blind authoring LLM **eyes** (an authenticated, text‑capturing crawl) and a **deterministic floor** (a gate that strips assertions referencing text the app demonstrably doesn't show) — so a hallucinated label can no longer turn a correct execution into a false `needs_human`, while staying fully transparent about what it skipped and why.
