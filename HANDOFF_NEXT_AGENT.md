# Handoff — QAAI Conductor Autonomy Work

**Repo:** `bharatvanapalli/QA-AI` (this repo)
**Branch:** `main`
**Start from commit:** `a4560a71` — pushed just before this handoff was written. `git log a4560a71` to see the fixes it contains and their full rationale in the commit message; read it before touching any of the files it names.
**Test target for everything below:** project **New_Odyssey** (`projectId: 1582559f-364f-4d0e-bfde-fd18832fdaa7`), test cases **"Login through email classifier and Microsoft sign-in"** (`4af44607-e59b-4cd4-85a2-68dc1e89cdc9`) and **"Create an order and validate complex form controls"** (`c7dabb04-0fef-4530-bad8-8c0f6622ed64`).

---

## 1. The mission — read this before writing any code

The platform owner's own words, verbatim, because paraphrasing loses the intent:

> "there is only one goal if there is no bug in actual website it is testing on then the testing should not stop it should continue performing each and every action as described instead of failing on not knowing on how to perform"

> "my platform should be a trustworthy for the users, users should be able to blindly trust it report, if it is failed to perform a step or if it is reported a test case failed then the only reason should be that the website has fault or bug not our platform"

> "the autonomous handling is when the conductor gets corrected itself or with the support of non human sitting in the backend" — if a step fails, the Conductor must self-correct **in the live run**, with Critic/Supervisor help, in real time. If that correction loop doesn't work, autonomous behavior is failing, full stop — a retry that happens after the whole case is over is not the same thing and does not satisfy this.

> "kernel validation which validates each step it should not falsely terminate a run just because it could not get enough evidence or unknown"

> "my platform should be able to know on how to perform each and every UI action that ever exist on all type of websites... do not hardcode anything, everything should be taught to our platform"

Every design decision below has to satisfy **all four** of these simultaneously. They are in tension with each other by design — e.g. "never false-pass" and "never falsely fail on missing evidence" pull in opposite directions — and reconciling that tension **is the actual job**, not a side detail. See §5 for how the fixes already in `a4560a71` approach this, and where they still fall short.

---

## 2. Process — do this in order, do not skip steps

1. **Read this document fully.** Then read the commit message of `a4560a71` in full (`git show a4560a71 --stat` then read the message).
2. **Investigate before designing.** Re-verify every claim in §5 below yourself — file:line, actual behavior — before trusting it. Memory/handoff documents go stale; the code is the source of truth. If something here turns out to be wrong, distrust this document, not your own verification.
3. **Design the architecture, then present it for confirmation before writing code.** The platform owner explicitly wants to review and confirm the approach before implementation starts — do not jump straight to editing files. Use whatever planning mode / plan-then-confirm workflow you have available.
4. **Build.**
5. **Test against New_Odyssey using the verification protocol in §3 — not your own judgment about what "looks right."** A run that shows `passed` in the UI is not evidence of anything by itself. See §3.
6. **Report back with the same rigor demanded of the platform**: don't claim something works because a run "looked clean" — show the actual evidence (journal entries, screenshots, WS log lines) that prove it.

---

## 3. Verification protocol — how to actually know whether a step passed

This is the most important section. The platform owner has caught false claims of success multiple times this session by looking at the **live browser with their own eyes** and comparing it to what the platform reported. Do not let that happen again. Concretely:

### 3.1 Never trust `RunResult.status` or the Live Pipeline UI alone
They reflect what the platform's own verification logic concluded — and that logic has already been proven wrong twice today (see §5.1, §5.3). Cross-check against:

- **The per-operation event journal**: `playwright/controller-journal/<runId>/*.jsonl`. This is the ground truth of what was actually dispatched and observed — `DISPATCH_STARTED`/`DELIVERY_RECORDED` (what tool call happened), `EXACT_*_DOM_READBACK`/`TYPED_ASSERTION_OBSERVATION` (what was actually read back from the live DOM, with literal `expected`/`observed` strings you can eyeball), `TERMINAL_DECISION` (what the state machine concluded and why).
  - **Read the raw `expected` vs `observed` strings yourself.** Don't trust the `matched` boolean. A matching bug can (and did) set `matched:true` on values that are visibly different once you read them side by side.
- **Screenshots, with the target element highlighted.** The codebase already has highlight infrastructure (`window.__qaai_highlight` injected into the page, `session.screenshots.push(...)` call sites in `controllerMcpRuntimeAdapter.js` — 11 scattered call sites as of `a4560a71`, grep `session.screenshots.push`). **This is NOT applied consistently to every step type today** — that is open work, see §6.2. Until it is: for any verification task, manually confirm a screenshot exists and shows the highlighted element for the step you're checking, don't assume it does.
- **A live, headed browser window you personally watch for at least the steps you're verifying.** The platform owner did exactly this and found two real bugs the platform's own reports missed entirely. Do the same before declaring anything fixed.

### 3.2 The specific trap that bit us twice today — read this carefully
Both confirmed false-pass bugs today had the same shape: a comparison function received two genuinely different values and returned `matched: true` anyway, because of an overly permissive matching rule (a delivery-status shortcut in one case, a prefix/substring tolerance in the other). **When you review or write ANY comparison/verification logic, ask: "if I feed this function two values that are actually different, under what conditions does it still say they match?"** Enumerate those conditions explicitly and check whether they're too broad. This is a generalizable review technique, not a one-off fix — apply it to every remaining comparator (`typedAssertionComparator.js` has ~10 comparison functions; only `compareText`'s `equals` branch has been re-audited this way so far).

### 3.3 Verifying "did the Conductor actually self-correct in real time" (§5.2)
Do NOT check the persisted journal file for this — `report()` calls in `browserTransactionController.js` do **not** write to the journal; they call a `heartbeat` callback that broadcasts over WebSocket as `controller.progress` / `controller.recovery` message types (wired in `controllerConductor.js` around the `createControllerRecoveryCoordinator`/`createBrowserTransactionRuntime` calls). To verify self-correction is firing:
1. Connect a WS listener (see `scratch/3-listen-full.cjs` for a working example, already listening for `controller.progress` messages with `reason === 'strategy_mismatch_escalating_ladder'`).
2. Trigger a real run.
3. Watch for the escalation log lines live, or grep your listener's captured output afterward.
Confirmed working proof-of-concept in this exact log shape as of `a4560a71`:
```
[LADDER-ESCALATE] op=...step.050 from=TIME to=CUSTOM_SELECT index=1
[LADDER-ESCALATE] op=...step.050 from=CUSTOM_SELECT to=TEXT_INPUT index=2
```
If you don't see lines like this during a run that has a step fail its first attempt, self-correction is not happening for that step — full stop, don't report it as working.

### 3.4 Headed vs headless — how to check, and how it's controlled
Precedence (see `server/services/mcp.js` ~line 1204-1215 and ~line 3671-3681, two separate call sites with the same logic — keep them in sync if you change one):
1. `project.contextHeadless` (boolean column on `Project`) — highest priority.
2. `project.triggerConfigJson` parsed JSON, `.contextHeadless` field — fallback if (1) is not a boolean.
3. Env vars `QAAI_MCP_HEADLESS` / `PLAYWRIGHT_MCP_HEADLESS` — fallback if neither of the above is set.
4. Default: `false` (headed) if nothing above resolves.

**How to verify which mode a run actually used, after the fact:** grep that run's server-side log output (or a live WS listener) for the line `DEGRADED [browser-topology]: browser launched in a non-portable mode: headed browser` — this line is emitted **only when `headless === false`** (see `reportBrowserTopologyPosture` in `mcp.js` ~line 965). Its absence means the run was headless. As of `a4560a71`, verified directly: New_Odyssey's `triggerConfigJson` is `{"contextHeadless": false}` and every test run this session showed this exact log line — **headed mode was confirmed active for every run in this session.** If the platform owner is separately observing headless runs, the most likely explanations to check first: (a) a different trigger route (`/execute` vs `/run-smoke` vs the `/agents/start` pipeline) building a different `project`-shaped object before it reaches `mcp.startMcpSession`, (b) a stale/cached project row somewhere with a different `triggerConfigJson`, (c) an env var override present in whatever process is actually serving the request — **check the actually-running process's environment, not just the repo's `.env` file** (this exact class of "the running process isn't running what you think it's running" bug wasted significant time earlier this session — see §5.4).

### 3.5 Before you report anything as fixed or working
State explicitly, with evidence:
- What you changed and why (file:line).
- The exact run(s) you verified it against (runId, timestamp).
- The exact log lines / journal entries / screenshots that prove the behavior, quoted, not summarized.
- What you did NOT verify and why (be honest about gaps — an unverified claim presented as verified is exactly the failure mode this whole handoff exists to prevent).

---

## 4. Non-negotiables (do not compromise on these to make progress easier)

- **No hardcoded, site-specific logic for New_Odyssey or any other single site.** Every fix must be a generic mechanism (a classifier, a comparator rule, a retry strategy) that applies platform-wide. If you're tempted to special-case "the Equipment dropdown on Odyssey," stop — that's the wrong layer. Fix the general widget-classification/verification mechanism instead.
- **No new false-pass paths.** Before merging any change to comparison/proof/verification logic, run the check in §3.2 against it.
- **No new false-hard-stop paths.** A step that can't gather decisive evidence should be reported honestly as unverified/failed for that step (per `EVIDENCE_BUDGET_EXHAUSTED`, see §5.1) — it must NOT set a `terminationReason` that kills the rest of a healthy, progressing run. Check `classifyControllerFailure` (`controllerFailureAttribution.js`) and `outcomeAllowsContinuation` (`controllerConductor.js`) whenever you touch failure classification, to confirm this property still holds.
- **Headed mode stays on** for any project configured for it (§3.4) — don't silently default to headless for convenience/speed while debugging; that's exactly the kind of drift the platform owner is worried about.

---

## 5. What's already fixed in `a4560a71` — verified, with evidence

Read the full commit message (`git show a4560a71`) for complete detail. Summary:

### 5.1 False-pass #1 — optimistic auto-commit on unverified actions
`browserTransactionController.js`'s `terminalFromProof` used to commit any ACTION operation as passed whenever the transport call didn't throw (`DELIVERED`) and proof was merely `UNKNOWN` — i.e. "the click didn't error" was treated as "the click did what was intended." Removed. Unverified actions now correctly route through `classifyControllerFailure`'s `EVIDENCE_BUDGET_EXHAUSTED` path — which reports the step as failed **without** setting a `terminationReason`, so the run keeps going. This is the mechanism that satisfies both "don't false-pass" and "don't hard-stop a good run" simultaneously — study it before building anything else in this area.

### 5.2 Self-correction ladder — reconnected, and a real bug in it fixed
`STRATEGY_LADDERS` / `getNextLadderStrategy` (`controllerTypedAdapterRegistry.js`) already existed as a mechanism for escalating a failed action to a different interaction strategy (e.g. TIME widget → CUSTOM_SELECT → TEXT_INPUT), wired into `browserTransactionController.js`. It was never actually engaging: escalation was gated on `Number(now()) < deadlineMs - 1500` (this call's remaining deadline) but every escalated attempt re-enters `execute()` which computes a **brand new** deadline — so a rung that used its entire budget internally (the common failure case) always failed this check and never escalated. Fixed by removing that stale-budget gate. **Verified live** — see the log lines quoted in §3.3.

**Still open in this same area:** even after escalating through all 3 strategies, the Early Pickup Time step in New_Odyssey's Create Order case still never verifies — see §6.1, this is a different, deeper bug (a literal JS syntax error in the time-field's DOM readback function) that the ladder fix correctly exposed but did not fix.

### 5.3 False-pass #2 — loose text-equality comparator
`typedAssertionComparator.js`'s `compareText` treated ANY prefix relationship between two strings ≥3 chars as "equal" for the `equals` comparator. Confirmed live: an assertion expecting `"*SIGROUP-EUR SOURCE SYSTEM 01"` passed against an observed value of `"SIGROUP"` — a 21-character, ~75% length difference — purely because one string is a literal prefix of the other. Fixed to require either true equality (after normalization) or a near-full-length match / literal ellipsis marker (to still tolerate genuine UI truncation, which was presumably the original intent). **This exposed a real, still-open question** — see §6.3.

### 5.4 Infrastructure trap — verify what's actually running
Spent significant time this session debugging why fixes "weren't working" before discovering the running backend process (`node server/index.js`, no nodemon/auto-reload) had never picked up any edits. **Before debugging any "my fix isn't working" scenario, first confirm the running process actually loaded your change** — restart via `scripts/restart-backend.ps1` (it verifies the PID before killing it, safe to run) and re-verify health (`curl http://localhost:5000/api/health`) before concluding anything about the fix's behavior.

### 5.5 Retry/escalation ladder at the case level (separate from §5.2's per-step ladder)
`runConductorWithRetries` in `server/routes/agents.js` used to call the Conductor once and return, despite its own docstring describing a full Critic → retry → Supervisor → final-attempt ladder. Reconnected for real — Critic gets real per-step evidence (built from `RunResult`/`stepResults`, not the legacy Claude-tool-loop shape these agents were originally written for) and proposes grounded rewrites; Supervisor escalates further if that's not enough. Includes a guard against retrying a case with an unmet session dependency (confirmed live that redoing a Microsoft-login flow a second time produces a different, unrelated failure rather than succeeding) — such cases keep their original single-attempt result rather than risking a worse outcome.

**Note the distinction from §5.2**: this is a whole-case-level retry that happens *after* a case finishes, which does NOT satisfy the "correct itself in the live run" requirement in §1 for mid-case failures — it's a second line of defense, not the primary mechanism. §5.2's per-step ladder is what actually does in-the-moment correction. Do not confuse the two or claim §5.5 satisfies the autonomy goal by itself.

---

## 6. What's still open — pick up here

### 6.1 Time-field DOM readback throws a literal syntax error (HIGH PRIORITY)
Confirmed via journal: `EXACT_TEMPORAL_OWNER_DOM_READBACK` events for the "Early Pickup Time" step repeatedly show `"ok":false,"reason":"Unexpected token ')'"` — a real JavaScript syntax error in the generated/injected readback function, not an ambiguity. This means the ladder in §5.2 escalates through all 3 strategies for nothing, because the underlying verification code is broken for every strategy. Find the function that builds this evaluate-string (likely near `buildTemporalOwnerReadFunction` or similar in `controllerMcpRuntimeAdapter.js` — search for the exact error string context, or search for how the time/date owner readback functions are constructed, likely template-string-generated JS with an unescaped value breaking the generated syntax) and fix the actual bug. This is probably the single highest-leverage fix remaining — it's a straightforward code defect, not an architecture question.

### 6.2 Screenshots + highlighting are not applied to every step
As of `a4560a71`, `session.screenshots.push(...)` appears at 11 scattered call sites in `controllerMcpRuntimeAdapter.js`, not centrally. The platform owner explicitly wants a highlighted screenshot for every step, no exceptions. Consider centralizing this at the gateway dispatch chokepoint (`rawCall` in `controllerMcpRuntimeAdapter.js`, or `controllerActionExecutionGateway.js`) rather than adding more scattered call sites — but this touches the hottest code path in the system, so design it carefully and test thoroughly rather than rushing it in.

### 6.3 Is "SIGROUP" vs "SIGROUP-EUR SOURCE SYSTEM 01" a test bug or a real mis-click?
The comparator fix in §5.3 now correctly reports this as `matched:false` — but nobody has yet determined WHY the field shows the short name. Two possibilities, not yet distinguished:
(a) The real Odyssey UI legitimately collapses to a short "SIGROUP" label after selecting either SIGROUP variant (product UI convention) — in which case the *test's assertion* is wrong to expect the full option text, not the platform.
(b) The composite dropdown-selection protocol actually clicked the wrong option.
**Resolve this by hand on the live site first** — manually select "*SIGROUP-EUR SOURCE SYSTEM 01" from that exact dropdown and see what the collapsed field shows. Do not guess; this determines whether there's a real selection bug to fix or just a test-authoring correction needed.

### 6.4 Order Number field appearing empty later in the run
Confirmed via journal: it was filled and verified correctly early in the Create Order case (`observed: "007995145"` matched `expected: "007995145"` with a genuine DOM value read), but was empty by a later point the platform owner directly observed live. Leading (unconfirmed) theory: selecting a different Customer than intended (§6.3) may legitimately trigger the real Odyssey app to reset dependent fields — a common enterprise-form pattern — and nothing in the current test re-verifies Order Number right before final submission. Needs direct confirmation (watch a live run through this exact transition) before concluding this is the mechanism, and before deciding whether the fix is "reorder the test's steps" (author-side) or "add a pre-submission re-verification pass" (platform-side, more aligned with §1's trust goal — a report should ideally catch this class of "value got clobbered later" issue on its own, not rely on step ordering being perfect).

### 6.5 The "any UI action on any website" goal (§1) is broader than New_Odyssey
New_Odyssey is the current test target, but the stated goal is universal. Once New_Odyssey's specific open items above are resolved, the next validation step should be a *second*, structurally different site (different component library, different widget conventions) to confirm nothing above was accidentally New_Odyssey-specific. Do not consider the architecture "done" on the strength of one site passing.

---

## 7. Files most relevant to this work

| File | Role |
|---|---|
| `server/services/browserTransactionController.js` | Core per-operation state machine: resolve → dispatch → observe → proof → commit/fail. Where §5.1 and §5.2 live. |
| `server/services/controllerTypedAdapterRegistry.js` | Widget classification (`inferAdapterKind`/`classifyLiveWidget`) and the strategy ladder (`STRATEGY_LADDERS`/`getNextLadderStrategy`). |
| `server/services/controllerMcpRuntimeAdapter.js` | The observer: builds DOM-readback evaluate functions, gathers proof claims, dispatches via `rawCall`. §6.1 and §6.2 live here. |
| `server/services/typedAssertionComparator.js` | All assertion comparison logic. §5.3 and the general review technique in §3.2 apply here. |
| `server/services/controllerFailureAttribution.js` | Classifies WHY an operation failed and whether that failure should halt the run (`terminationReason`). Central to the "don't false-hard-stop" non-negotiable. |
| `server/routes/agents.js` (`runConductorWithRetries`) | Case-level retry/escalation ladder (§5.5). |
| `server/services/agents/critic.js`, `server/services/agents/supervisor.js` | The two escalation agents §5.5 wires in. |
| `playwright/controller-journal/<runId>/*.jsonl` | Ground-truth event log per run — use this, not the UI, per §3.1. |
| `scripts/restart-backend.ps1` | Safe backend restart (verifies PID ownership before killing) — use this after every server-side edit, per §5.4. |
| `scratch/2-trigger-run-both.cjs`, `scratch/3-listen-full.cjs` | Working examples for triggering a New_Odyssey run and listening to its WS event stream, including the `LADDER-ESCALATE` capture from §3.3. |
