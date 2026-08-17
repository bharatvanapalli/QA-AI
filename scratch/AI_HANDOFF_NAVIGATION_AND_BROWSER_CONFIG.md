# AI Handoff & Technical Specification: URL Navigation & Browser Launch Handling

## Overview & Architecture Context
This document specifies the contract mapping, URL navigation, and browser context configuration rules for the QAAI execution pipeline (specifically `controllerConductor.js`, `operationContractV2.js`, and `mcp.js`).

---

## 1. Initial Browser Session Launch (`targetUrl` Handling)

### Root Cause & Problem
When executing test cases using the `ControllerConductor` (`server/services/agents/controllerConductor.js`), unauthenticated root test cases (cases without a `dependsOn` dependency) initialize a fresh browser session via `mcp.startMcpSession`. Previously, `targetUrl: null` was hardcoded:

```javascript
// BEFORE (Bug):
browserSession = await mcp.startMcpSession({
  userId,
  targetUrl: null, // Hardcoded null caused Chromium to boot to about:blank
  broadcast: send,
  project: projectConfig || {},
  authorityMode: 'browser_transaction_controller',
});
```

### Resolution & Pattern
Always pass the resolved project target URL when spawning a new browser session for a test case:

```javascript
// AFTER (Fixed):
const initialTargetUrl = targetUrl || projectConfig?.targetUrl || process.env.QAAI_TARGET_URL || null;
browserSession = await mcp.startMcpSession({
  userId,
  targetUrl: initialTargetUrl,
  broadcast: send,
  project: projectConfig || {},
  authorityMode: 'browser_transaction_controller',
});
```

---

## 2. `Navigate` Step Contract Target Mapping & Fallback

### Root Cause & Problem
When an authored test step specifies a `Navigate` action (e.g., `"Navigate to https://qa.linx.odysseylogistics.com/..."`), step authoring or LLM planning often places the destination URL in `source.target`, `source.element`, `source.authoredText`, or `source.text` while leaving `source.value` as `null`.

Because `operationContractV2.js` classifies `Navigate` under `NEVER_HAS_TARGET_ACTIONS` (element target identity is set to `null`), the lack of a fallback in `normalizeValue` caused both `operation.value` and `operation.target` to evaluate to `null` / `""`.

During execution verification, this resulted in:
`Navigation to "" could not be confirmed — the destination page did not load or URL did not match.`

This single failure at Step 1 caused all 20+ dependent steps to be skipped.

### Resolution & Pattern
In `server/services/operationContractV2.js`, `normalizeValue` for `Navigate` actions extracts the destination URL from `source.target`, `source.element`, `source.authoredText`, or `source.text` whenever `source.value` is `null`:

```javascript
// operationContractV2.js (normalizeValue):
let value = hasValue ? clone(source.value) : null;
if (type === 'Navigate' && !value && !valueRef) {
  const rawCandidate = clean(
    (typeof source.target === 'string' ? source.target : textFromTarget(source.target))
    || source.element
    || source.authoredText
    || source.text
  );
  const urlMatch = rawCandidate.match(/https?:\/\/[^\s"']+/i);
  if (urlMatch) {
    value = urlMatch[0];
  } else if (rawCandidate && (/^https?:\/\//i.test(rawCandidate) || /^\//.test(rawCandidate))) {
    value = rawCandidate;
  }
}
```

In `server/services/agents/controllerConductor.js`, error formatting (`verdictError`) and step reporting (`operationRows`) fall back to `op.value || op.plannedText || op.destination || op.valueRef` when `op.type === 'Navigate'`:

```javascript
// controllerConductor.js:
const target = clean(
  op?.targetIdentity?.accessibleName
    || op?.targetIdentity?.label
    || op?.target
    || (op?.type === 'Navigate' ? (op?.value || op?.plannedText || op?.destination || op?.valueRef) : ''),
) || '';
```

---

## 3. Headed vs Headless Browser Execution Control

### Resolution & Priority Chain
Browser launch mode (Headed vs Headless) is evaluated inside `server/services/mcp.js` (`startMcpSession`) using the following priority hierarchy:

1. **Project Specific Toggle** (`Project.contextHeadless` column in database or inside `Project.triggerConfigJson` e.g. `{"contextHeadless": false}`).
2. **Environment Overrides**:
   - `QAAI_MCP_HEADLESS=false` (or `PLAYWRIGHT_MCP_HEADLESS=false`) forces Headed mode across all runs.
   - `QAAI_MCP_HEADLESS=true` (or `PLAYWRIGHT_MCP_HEADLESS=true`) forces Headless mode across all runs.
3. **Default Fallback**: Headed mode (`false`) on dev workstations, Headless (`true`) in CI.

To force **Headed** mode in another client VM environment:
* Set `QAAI_MCP_HEADLESS=false` in `.env`.
* Or update the project config: `triggerConfigJson: "{\"contextHeadless\": false}"`.

---

## Instructions for AI Agents Working on Other Client VMs
When deploying or executing QAAI runs in another environment:
1. Ensure `server/services/agents/controllerConductor.js` passes `initialTargetUrl` into `mcp.startMcpSession`.
2. Ensure `server/services/operationContractV2.js` contains the URL regex extraction fallback in `normalizeValue`.
3. If Step 1 `Navigate` reports `Navigation to "" could not be confirmed`, verify that `op.value` or `plannedText` is extracted properly from `source.target` or `source.text`.
4. If browser windows do not open visually on a client VM, set `QAAI_MCP_HEADLESS=false` in `.env`.
