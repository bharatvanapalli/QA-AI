# Onboarding for Antigravity — read this before touching anything

You are working on QAAI Portal, an autonomous QA platform. This file exists because past sessions (yours and Jules') wasted real time — hours of it — by editing dead code, guessing intent from UI text, and restarting shared processes carelessly. Read this fully before making any change.

## 1. The one execution path that matters

Every real browser test run goes through exactly this chain:

```
server/routes/agents.js (trigger route)
  → server/services/agents/controllerConductor.js
    → server/services/browserTransactionController.js
      → server/services/controllerActionExecutionGateway.js
        → server/services/controllerMcpRuntimeAdapter.js
          → server/services/controllerTypedAdapterRegistry.js
            → MCP / Playwright (browser)
```

The test case's authored steps (`TestCase.steps`, JSON) are compiled into an `OperationContractV2` by `server/services/operationContractV2.js` before any of the above runs. That compiled operation — not the raw authored JSON — is what the pipeline actually executes.

**Before you edit any file, prove it's in this chain.** Grep for its `require()` in `controllerConductor.js` (directly or transitively). If it's not reachable from there, it does not affect a live run, no matter how relevant it looks.

**Confirmed dead for this path** (do not edit expecting live effect): `server/services/controlActionAdapter.js`, `server/services/universalActionKernel.js`, `server/services/conductorUniversalRuntime.js`, `server/services/testDesignStepCompiler.js`. A prior session burned multiple cycles editing `controlActionAdapter.js`'s Append logic with zero effect on real runs, because it's not in the chain above.

## 2. The rule that would have prevented most of today's bugs: never guess from text at runtime

Every bug we found and fixed today came from either (a) an exception being silently swallowed with no trace, or (b) code trying to infer intent from a UI element's label or action text *at runtime*, instead of using a signal the compiler already produced.

**The correct place to encode intent is the compiler, not the runtime adapter.** Here's the actual, general pattern already used successfully for assertions in this codebase — copy this shape for any new action semantic, on any project, for any website:

- `operationContractV2.js` has `TYPE_INFERENCE_RULES` (a list of regex → canonical type mappings, e.g. `{ pattern: /^\s*clear\b/i, type: 'Clear' }`) applied to the *authored action text* — a real, structured, compile-time field — not to a live DOM label read moments before an action.
- For assertions specifically, `inferAssertionType(actionText)` goes further and derives a *specific sub-type* from the text (`"Confirm the field is disabled"` → `AssertDisabled`). Actions currently don't have an equivalent mechanism for sub-typing within a single compiled type — that's the actual gap behind today's Append bug (see §4).
- Downstream code (`controllerTypedAdapterRegistry.js`'s `planTextInput` and friends) should branch on `operation.type` / a structural field the compiler set — **never** on `elementLabel`, `accessibleName`, or any other UI-observed text, and never at the point of dispatch/observation.

If you ever catch yourself writing `/\bsomething\b/i.test(elementLabel)` inside `controllerMcpRuntimeAdapter.js` or `controllerTypedAdapterRegistry.js` — stop. That's the exact anti-pattern that caused this whole debugging marathon (a real field named e.g. "Clearance Level" would get hijacked by a `/clear/i` check on its label). The fix belongs in the compiler, keyed off the *authored instruction text*, which is a legitimate, stable, structured input — not off whatever a live page happens to render.

## 3. Never let an exception disappear silently

`gateway.dispatch()` → `transport()` in `controllerActionExecutionGateway.js` / `controllerMcpRuntimeAdapter.js` is the single choke point every mutation passes through. Today's biggest bug (nothing ever reached the browser, for *any* project) was a `TypeError` thrown one line before every dispatch, caught by a bare `catch (error) { ... }` that converted it into a generic "delivery uncertain" status with **zero console output anywhere**. It took hours of adding temporary tracing at every layer to find.

Rule: every `catch` block anywhere in the dispatch → transport → observe → proof chain must `console.error` the real `error` object (not just a derived reason string) before converting it to a status. This is not optional defensive style — it is why we could eventually find every other bug today.

## 3a. A real incident, so this isn't abstract: verify before you commit, always

On 2026-08-08, an edit was made to `controllerMcpRuntimeAdapter.js`'s `transport()` function (a "pre-clear before typing" step) that called `session.client.callTool(..., requestOptions)` — `requestOptions` was never declared anywhere in the file. A guaranteed `ReferenceError`, on every single plain Fill/Type action. It went unnoticed because it was wrapped in its own `catch (_) {}`, so the broken code never once actually ran, and nobody checked a real run's `RunResult.stepResults` to notice it wasn't taking effect. It also called `session.client.callTool()` directly — bypassing `protectMcpSessionClient()`'s deliberate block on raw, ungoverned mutating tool calls outside the `ActionExecutionGateway`.

Neither mistake would have survived actually running the change once and checking the database. **That is the standing bar now**: before you consider any change to a shared pipeline file done, trigger a real run (see §5) and check `RunResult.stepResults` for the specific step you touched. Reading the code back to yourself is not verification. If you can't run and verify it yourself, say so explicitly and stop.

## 4. Current known state (as of 2026-08-08) — don't take this as gospel forever, re-verify

**Fixed and verified this session** (in `server/services/`):
- `controllerMcpRuntimeAdapter.js`'s `transport()` was mutating a frozen object (`Object.freeze()`'d in `controllerTypedAdapterRegistry.js`'s `mutation()` helper) — fixed by cloning before mutating.
- `typedAssertionComparator.js`'s `compareTypedAssertion` never stripped the `"Assert"` prefix from compiled types (`AssertValue` vs the bare `VALUE` its branches check for) — fixed, and also hardened the fallback so an unsupported type can never leak a raw object into user-facing narration again.
- `controllerMcpRuntimeAdapter.js`'s `snapshotOwnerValue` only read a same-line `[ref=eXX]: value` suffix from the accessibility snapshot; some fields render their value as a nested child line instead — fixed by reusing the existing `extractCandidateValue()` helper, which already handled that shape.

**Open, unsolved — and here's the general lesson each one teaches, not just the specific fix:**

1. **Append has no structural signal.** `operationContractV2.js` line ~88 maps action text starting with "append" to `operation.type: 'Type'` — the *same* compiled type as a plain Fill. There is currently no way to distinguish "append to existing value" from "overwrite" on the compiled operation. The only thing making Append work at all today is a label-sniffing regex in `controllerMcpRuntimeAdapter.js`'s `transport()` (`isAppendOp`) — exactly the anti-pattern in §2, kept only because nothing better exists yet. **Do not delete it until you've added the replacement.** The general fix: give the compiler a structural way to mark this — e.g. `append: true` alongside `type: 'Type'` when the append-inference rule matches — and read that field downstream instead of re-deriving intent from text at runtime.
2. **A LetCode-specific field ("Clear the text") won't clear.** `reason: text_input_owner_value_not_committed` — the mutation dispatches, a real interaction happens, but reading the field back afterward shows the old value unchanged. This is likely a site-specific quirk (the field may need an actual Clear button/icon clicked, not a programmatic value write) — **don't generalize a fix for this one field into the shared adapter code.** If it's genuinely site-specific, it belongs in that project's own config/authoring, not in `controllerTypedAdapterRegistry.js`. Only change shared code if you find the *general* mechanism (e.g. "we're not correctly triggering a change/input event after fill()") is broken for more than this one field — and prove that with evidence, not assumption.
3. **Repeated identical narration.** The live transcript can print the exact same `Action failed · ...` line up to 7 times for one failing step (once per observation-retry cycle). Real UX bug, not yet fixed — needs deduping keyed by `operationId` + narration text, scoped per-run (not a module-level global, or it'll leak across unrelated runs).

## 5. How to verify anything you claim fixed

Code review is not verification. Today, multiple "this should work now" claims (mine included) turned out wrong until checked against real data. The reliable method:

1. Trigger a real run via `POST /api/projects/<projectId>/agents/run-smoke` with `{ "testCaseIds": [...], "generationId": "..." }`.
   - Auth: `requireAuth` reads a JWT from a cookie named `token` (payload fields `sub`, `email`, `role`, signed with `process.env.JWT_SECRET`) — not an `Authorization` header.
   - CSRF: double-submit — send the same random value as both the `XSRF-TOKEN` cookie and the `x-xsrf-token` header.
   - The project's `orgId` must match the signed-in user's `currentOrgId` (multi-tenant scoping) — mismatch gives a 404, not 401/403.
2. Poll the `Run` table (by `projectId`, most recent `startedAt`), then `RunResult.stepResults` — a JSON array, one entry per step, each with `index`, `action`, `status`, `reason`. That is ground truth.
3. Don't trust the live WebSocket transcript in the browser alone — it can show stale state after a backend restart (the WS connection breaks and doesn't always reconnect cleanly).
4. Run the *whole* test case end-to-end after any fix, not just the step you changed.

## 6. Process hygiene — this is what actually cost the most time today

- **Check who owns the process before restarting anything.** Before `npm run server:restart` or killing anything on port 5000, verify the current owning PID actually is this repo's `server/index.js`. If another agent or terminal might be using it, say so and confirm before restarting.
- **Health checks need real time.** This machine's backend startup (including an orphan MCP/Chrome sweep) can take 15-25+ seconds — a health check that fails at 15s doesn't mean it's stuck; wait longer before concluding it's down.
- **Don't touch headless/headed mode.** Headed mode is deliberate here — a human watches the live browser. Never flip `contextHeadless` / `QAAI_MCP_HEADLESS` as a side effect of an unrelated fix.
- **Never commit secrets.** We had a real Anthropic API key committed in plaintext to `main` earlier today (since rotated and removed). Before any commit, check `git diff` for anything that looks like a key, token, or credential — even in a file with an innocuous name.
- **Don't guess intent from UI labels — see §2. This is the single most repeated mistake across every agent that's touched this repo.**

## 7. If you want more history

`CLOUD_AGENT_SYNC.md` in this same repo root has the turn-by-turn exchange with Jules (another cloud agent) covering the same open problems in more granular detail, including a corrected/rejected proposal for the Clear fix (it suggested a tool called `browser_clear` that does not exist — verified against the actual installed `@playwright/mcp` package). Worth a skim if you want more context before starting on problem #1 or #2 above.
