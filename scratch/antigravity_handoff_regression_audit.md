# Handoff: Regression audit — New_Odyssey TS2/TC1 ("Create an order and validate complex form controls")

## Context

QAAI Portal is an autonomous QA platform. Claude (me, in a separate session) spent an extended
investigation today root-causing and fixing a regression on New_Odyssey's TS2/TC1 test case
("Create an order and validate complex form controls" — 87 authored steps). The user has
directed me to hand this off to you for an independent regression audit before deciding next
steps together. Do not treat this as "go fix everything" — the ask is: **audit what I changed,
verify it's correct, find whatever I missed, and report back.** We decide together after your
findings.

**Critical constraint — read this before doing anything else:** this session triggered 12+ full
live Microsoft SSO logins against New_Odyssey's real system in the last ~2 hours to verify fixes.
The most recent run failed at an *unrelated* step ("Customer" search-and-select) that has never
failed before and has nothing to do with any of the code touched today. That is the signature of
server-side rate-limiting/throttling, not a code regression. **Do not trigger new live runs
against New_Odyssey (no new logins, no new `run-smoke` triggers) unless the user explicitly asks
for it in this session.** Do your audit from the artifacts that already exist: git history,
journal files under `playwright/controller-journal/`, and the `RunResult` table in the DB. If you
believe a live run is genuinely necessary to resolve something, stop and ask first — don't decide
that unilaterally.

## What was found and fixed (3 commits, all on `main`, not pushed)

Run `git log --oneline -5` to see them. In order (oldest first):

### Commit `e0f7dee` — LetCode ref/target regression + transcript rewrite
Unrelated to New_Odyssey directly, but touches the same shared files. Root cause: an earlier
commit (`4aaedc3`) swapped the `browser_evaluate` MCP tool's element-reference parameter from
`target` to `ref` at 7 call sites in `controllerMcpRuntimeAdapter.js` and `mcp.js`. The real
`@playwright/mcp` tool only recognizes `target`/`element` — passing `ref` silently no-ops the
element binding. This broke ClickAndHold, Semantic GetSize/GetColor/GetLocation reads, and
assertion highlighting. Fixed the remaining broken call sites, added highlight+screenshot
evidence for standalone Verify/Assert steps (previously skipped because they resolve entirely at
the `pre_dispatch` phase), fixed a disabled/readonly assertion misclassification bug
(`inferAssertionType` in `operationContractV2.js` only saw the generic action word "Verify", not
the descriptive text that actually said "...is disabled" — this was silently weakening what got
verified, not just mislabeling it), and rewrote transcript narration to state real observations
instead of generic/meaningless fallback text.

**Verify this yourself against LetCode TC1/TC2** if you want independent confirmation — those
don't touch New_Odyssey's real login, so they're safe to re-run freely.

### Commit `603b51f` — New_Odyssey dropdown/collection verification fixes
This is the main one to audit carefully. Root-caused via live evidence (not guesswork) why
New_Odyssey's Ship Direction dropdown kept failing/looping even though it was visibly open on
screen. Five stacked issues, each with a code comment at the fix site explaining the live
evidence that led to it:

1. **`browserTransactionController.js`** (~line 733): the observation-only reconcile loop broke
   out after the FIRST reconcile attempt on any `MISMATCH` result, only continuing to retry on
   `UNKNOWN`. This meant a genuinely-still-rendering page got exactly one zero-delay retry instead
   of the full backoff budget. Changed to match the policy already used one step earlier in the
   same file (the pre_dispatch→reconcile transition, which correctly only short-circuits on
   `MATCHED`): only a confirmed match (or a terminal boundary — `manualBoundary`/`sessionLost`)
   should stop the loop early.

2. **`controllerMcpRuntimeAdapter.js`** — the `COLLECTION`/`COLLECTION_MEMBERSHIP` assertion
   branch (~line 366, inside `evaluateControllerAssertionSnapshot`) only trusted
   `option`/`menuitem`/`listitem`/`radio` roles. Real custom dropdowns render rows as
   `button`/`checkbox`/`tab`, or with **no ARIA role at all** (`generic`). Rewrote the filter to
   match candidates by whether their accessible-name text IS one of the fixed expected values
   (not by role or inferred structural scope) — this is what makes broadening the role set safe:
   relevance is decided by value match, not by trusting a role blindly. Also collapses consecutive
   duplicate values (this specific site renders each dropdown option as two DOM nodes with the
   same accessible name — a real accessibility/measurement duplicate-rendering pattern, not a bug
   in our dedup).

3. Reverted the assertion-highlight/evidence-screenshot code (added earlier today, in commit
   `e0f7dee`) from **awaited** back to **fire-and-forget**. It was briefly made blocking to
   guarantee the screenshot caught the highlight flash, but for a transient target like an open
   dropdown, the added ~1-5s delay gave the popup time to close between the pre_dispatch check and
   the immediate reconcile re-check. Cosmetic evidence must never block the actual verification
   pipeline.

4. **The deepest layer — `mcp.js`'s `parseSnapshotLine`** (~line 218): the regex only extracted a
   name from a *quoted* string immediately after the role token (`button "Submit" [ref=e5]`).
   Live evidence: New_Odyssey's unselected Ship Direction option rendered as
   `generic [ref=e2780] [cursor=pointer]: Inbound` — name after a colon, unquoted, no role at all.
   The regex extracted an EMPTY name for this line, so the element could never become a usable
   candidate no matter what role it carried, regardless of any role-set fix. Added a fallback:
   when the primary quoted-name capture finds nothing, extract trailing `: text` from the rest of
   the line. Only fires when the primary capture is empty, so normal quoted-name lines are
   unaffected. **This is the fix most worth independently verifying** — it's a raw regex change to
   how EVERY accessibility snapshot line on EVERY site gets parsed, so a subtle mistake here has
   wide blast radius.

5. **`semanticSelectionState.js`** — the live click-target search (`optionSelector`,
   `popupOptionSelector`) had the same role gap, plus a new problem once broadened to `'*'`
   (needed because "generic" isn't a literal HTML attribute a CSS role-selector can match): one
   visual option started matching at multiple nested DOM depths, each resolving to a different
   "action owner" and reporting false ambiguity (`virtualized_selection_rendered_candidate_ambiguous`,
   candidateCount 4, live evidence). Fixed by collapsing to leaf-most owners (drop any owner that
   contains another matched owner as a descendant) before requiring uniqueness.

**Verified live end-to-end**: went from 23/87 to 80/87 steps passing across repeated runs, with
the full login → Equipment dropdown → Ship Direction dropdown → Freight Term dropdown →
References → Planning Date/Time chain executing correctly, including all 4 calendar
date-selections succeeding.

### Commit `2a1d17d` — transcript leak + retry-spam
Two bugs found from reading the actual live transcript output (not code review):
1. The generic assertion-narration fallback JSON.stringifies any non-string "expected" value. When
   that value was an array of `{name, role}` objects (a Date/Time ordering check), the raw JSON
   blob leaked into the transcript as `[{"name":"Early Pickup Date/Time","role":null},...]`. Now
   parses it back into a readable name list.
2. The assertion-highlight code and the "page changed, re-located X" diagnostic both fired
   unconditionally on every reconcile attempt, producing 6-7 near-identical "Action failed" lines
   for one field before any real information changed. Added per-operation dedup so only a
   genuinely new observation (different reason, or the eventual success) sends a new transcript
   line.

## What is explicitly NOT fixed — known open items

1. **Field-value-confirmation gap**: after successfully selecting a value (Ship Direction,
   Freight Term, and all 4 Date/Time fields), a separate `VALUE`-type assertion confirming "does
   the field now display X" fails with `typed_assertion_target_missing` /
   `exact_proof_unavailable`. Traced this far: the failure is in `uniqueBestAssertionTarget` /
   `rankSemanticCandidates` / `scoreSemanticCandidate` (name-ranking) failing to find ANY candidate
   for a target like "Ship Direction field" post-selection — NOT the same class of bug as the
   COLLECTION fix above. This needs its own investigation; I ran out of budget to fully trace it.
   Start at `evaluateControllerAssertionSnapshot`'s default fallback branch
   (`uniqueBestAssertionTarget(operation, contract, candidates)`, around line 450) in
   `controllerMcpRuntimeAdapter.js`.

2. **Calendar "Element Not Found" transient**: during the composite calendar protocol
   (`createCalendarProtocol` in `controllerCompositeProtocols.js` — I did NOT edit this file, it's
   the user's own existing logic and untouched), the transcript showed "Element Not Found / Could
   not locate 'element' on the page" during date-picking, immediately followed by successful
   resolution ("I can confirm: 2026-08-20"). This looks self-recovering (the composite protocol's
   own phase-retry likely handles it) but I could not conclusively identify which phase emits this
   specific diagnostic with an empty `target` field before the connection to my WS listener
   dropped. Worth confirming whether this is truly benign or masking something.

3. **Whether tonight's failures are code or rate-limiting**: the last run failed at "Customer"
   search-and-select, upstream of everything touched in commit `603b51f`, after very heavy
   automated login volume. This needs to be disambiguated — ideally by checking with the user
   about whether the New_Odyssey account/environment has any known automated-access protections,
   OR by waiting before the next live verification and seeing if the same early failure recurs.

## What we need from you

1. **Read the 3 commits** (`e0f7dee`, `603b51f`, `2a1d17d`) in full via `git show <hash>`. Check
   each stated root cause against the actual diff — does the code change plausibly fix what the
   commit message claims? Flag anything that looks wrong, incomplete, or riskier than described.
2. **Cross-check the reasoning against the journal evidence already on disk** under
   `playwright/controller-journal/` — there are multiple run directories from today
   (`0b03f870-...`, `c0199e87-...`, `096a1b98-...` and others; check `RunResult.runId` in the DB
   for the full list against `testCaseId = 'c7dabb04-0fef-4530-bad8-8c0f6622ed64'`) with raw
   `TYPED_ASSERTION_OBSERVATION` / `EXACT_SELECTION_OWNER_DOM_READBACK` events that back up the
   claims above. Confirm the evidence actually supports the conclusions, not just that the
   conclusions sound plausible.
3. **Investigate open item #1 (field-value-confirmation gap)** using existing journal data first.
   If you can root-cause it without a new live run, propose a fix (don't apply it — report it) the
   same way commit `603b51f`'s message documents each fix with the specific live evidence that
   justified it.
4. **Investigate open item #2 (calendar transient)** similarly — check whether
   `controllerCompositeProtocols.js`'s phases have their own retry/backoff, and whether the
   "Element Not Found" diagnostic is cosmetic noise or a real gap.
5. **Do NOT trigger a new live run against New_Odyssey** to do any of this unless you've
   exhausted what's in the existing journals/DB and truly need fresh data — and if so, stop and
   ask the user first, explaining specifically what you need to observe and why it can't come from
   existing artifacts.
6. **Report back** with: what you verified as correct, what you found wrong or risky in my
   changes, and a proposed (not applied) plan for the two open items. We'll decide from there
   whether you implement it, I do, or we run one more live verification together.

## Key file map for this investigation

| File | What changed / relevance |
|---|---|
| `server/services/browserTransactionController.js` | Reconcile-loop exit condition fix |
| `server/services/controllerMcpRuntimeAdapter.js` | Collection-check role/value matching, transcript narration, dedup |
| `server/services/mcp.js` | `parseSnapshotLine` regex fallback for unquoted/colon-style names |
| `server/services/semanticSelectionState.js` | Live click-target search role broadening + leaf-owner dedup |
| `server/services/controllerCompositeProtocols.js` | Calendar/time composite protocols (user's own code, untouched today) |
| `server/services/operationContractV2.js` | `inferAssertionType` input broadening (from commit `e0f7dee`, LetCode-related) |

## Database identifiers for reference

- New_Odyssey project: `1582559f-364f-4d0e-bfde-fd18832fdaa7`
- TS1 (login): `4af44607-e59b-4cd4-85a2-68dc1e89cdc9`
- TS2 (Create Order): `c7dabb04-0fef-4530-bad8-8c0f6622ed64`
