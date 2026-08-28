# QAAI Platform Issues & Architectural Audit Report

**Date:** August 28, 2026  
**Audience:** QA Leads, SDETs, Core Engineering  
**Scope:** Complete forensic breakdown of current platform execution bottlenecks, reliability flaws, deterministic repetition, and architectural remediations.

---

## Executive Summary

During intensive live execution on complex enterprise applications (e.g., Odyssey ONE / PrimeNG / Angular), the QAAI execution pipeline surfaced several critical issues:
1. **Severe Latency & Artificial Freezing** (multi-minute runs across 80+ steps).
2. **"Xerox-Copy" Deterministic Mistake Repetition** (repeating identical false bindings on every run).
3. **Erratic Viewport Jumping & Speculative Preflight Probes** (scrolling down to probe future elements then jumping back).
4. **Unclosed Floating Overlays Obstructing Form Fields** (calendars/dropdowns remaining open and blocking subsequent steps).
5. **False Passes vs. Verification Gaps** (declaring success without verifying physical DOM mutation).
6. **Environment & Process Lifecycle Collisions** (Prisma client schema drift and loopback dual-stack resolution).

This document details each issue, its physical root cause in the codebase, the immediate remediations applied, and the permanent architectural blueprint.

---

## 1. Execution Latency & Freezing (The Double-Snapshot Tax)

### The Symptom
The Conductor pauses for 5–10 seconds between individual actions, resulting in 87-step suites taking **8 to 15 minutes** while the browser appears frozen.

### Root Cause Analysis
For every single step in an authored scenario, the legacy execution loop triggered two full accessibility tree serializations over WebSocket (`browser_snapshot`):
```
[Step N]  ──►  [Full MCP Snapshot]  ──►  [Pre-Check]  ──►  [Action Dispatch]  ──►  [Wait Settle]  ──►  [Full MCP Snapshot]  ──►  [Proof Check]
                    (~1.2s)                (~0.5s)            (~1.0s)                (~0.8s)               (~1.2s)                (~0.5s)
                                    Total per step = 5.2s  ×  87 steps  =  452+ seconds (~8 minutes)
```
1. **Accessibility Tree Overhead:** In enterprise SPAs with hundreds of form controls, tree serialization and JSON wire transfer take 1,200ms per roundtrip.
2. **Artificial Reconciliation Backoffs:** `browserTransactionController.js` introduced `initial_dom_quiescence_settle` and `bounded_framework_settle_backoff` pauses (80ms–1500ms) even when the DOM was already settled.

### Architectural Solution
- **In-Page DOM Execution Engine (`universalDomEngine.js`):** Injected lightweight JavaScript executes element resolution, accessible name computation, and atomic interaction directly in the page runtime ($\approx 20\text{ms} - 50\text{ms}$ instead of $1,500\text{ms}$ wire transfer).
- **Reduced Snapshot Frequency:** Full accessibility snapshots are only captured at key state boundaries rather than twice per sub-step.

---

## 2. "Xerox-Copy" Deterministic Mistake Repetition

### The Symptom
On every new run, the Conductor repeated the exact same mistakes made in previous runs (e.g., entering an Order Number into the Customer field) unless engineers manually modified the backend code.

### Root Cause Analysis
```
┌──────────────────────────────────────────────┐
│ Authored Plan: Rigid array of static strings │ (e.g. "Enter an ID")
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ Deterministic Formula (No Cross-Run Memory)   │ (Score(Customer) = 90, Score(OrderNo) = 85)
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ Conductor Binds Customer Field (Every Run)   │ ◄── 100% Identical Output
└──────────────────────────────────────────────┘
```
1. **Static Pre-Authored Steps:** Test cases are stored as immutable string arrays in the database. The engine executes them in a rigid loop without self-correcting the target definitions.
2. **Zero Memory Between Runs:** Deterministic algorithms are stateless. Given the exact same DOM and query, they will produce the exact same mathematical score and mistake indefinitely.
3. **No Vision-Driven Live Correction:** The deterministic kernel lacked live screenshot inspection to visually detect that a value was typed into the wrong box.

### Architectural Solution
- **Knowledge Base Locator Persistence (E1 Protocol):** Successful and verified bindings are stored in `KnowledgeBaseLocator`. Subsequent runs query this persistent store first.
- **Hierarchical Form-Group Scoping:** Target matching evaluates the enclosing `<fieldset>`, `form-group`, or table row rather than global placeholder matching.
- **Visual Supervisor Feedback:** Enable the Visual Critic to inspect live screenshots and flag misaligned inputs dynamically.

---

## 3. Erratic Viewport Jumping & Preflight Reveal Probes

### The Symptom
While filling a form, the browser suddenly scrolls down to the bottom of the page, does something invisible, and then scrolls back up to continue where it left off.

### Root Cause Analysis
- Located in `conductorUniversalRuntime.js` (`scroll-target-into-view` and `Target Reveal` hooks).
- Before executing a step, the engine triggered speculative probes to check if future sections or accordion panels were rendered in the DOM.
- If an element was below the viewport fold, the probe forced a scroll to verify presence, followed immediately by a scroll back to the active field.

### Architectural Solution
- **Eliminated Speculative Preflight Scrolls:** Elements are scrolled into view **only once**, at the exact moment of interaction (`scrollIntoViewIfNeeded()`).
- **Sequential FIFO Queue:** Actions are strictly queued and executed sequentially ($1 \to 2 \to 3 \dots \to N$).

---

## 4. Unclosed Floating Overlays Obstructing Subsequent Fields

### The Symptom
When interacting with date pickers or dropdowns, the conductor leaves the overlay open in the middle of the screen and moves to the next field, causing the next field to be covered and unclickable.

### Root Cause Analysis
```
┌─────────────────────────────────────────────────────────────┐
│  Form Field: [ Late Delivery Date ]                         │
│                                                             │
│  ┌───────────────────────────────────────────────┐          │
│  │   FLOATING CALENDAR OVERLAY (z-index: 1000)   │ ◄─── Left Open!
│  │   [ August 2026 ]                             │          │
│  │   1  2  3  4 ... 21 ... 31                    │          │
│  └───────────────────────────────────────────────┘          │
│                                                             │
│  [ Late Delivery Time ] ◄─── OBSTRUCTED by the calendar!    │
└─────────────────────────────────────────────────────────────┘
```
- In frameworks like PrimeNG, date pickers and dropdown lists render as absolute overlays injected at the `<body>` level with `z-index: 1000`.
- When the runtime committed a date/option via internal setters without triggering an outside click or `Escape` key, the floating modal remained active.
- When the next step attempted to interact with the Time dropdown, the calendar overlay was physically in the way, triggering auto-scroll evasion failures.

### Architectural Solution
- **State-Driven Settlement & Overlay Dismissal:** After any calendar or dropdown selection, the engine automatically dispatches a settlement event (`Tab`, `Escape`, or backdrop dismiss) to ensure overlays are 100% closed before the next step begins.

---

## 5. False Passes vs. Verification Integrity

### The Symptom
Steps were marked as passed even when values failed to visually populate, or cases were marked failed due to uncheckable snapshot timing gaps.

### Root Cause Analysis
- **Synthetic Pass Claims:** The engine previously accepted synthetic `assertion_check` outputs without confirming live DOM element values.
- **Snapshot Timing Mismatches:** If an option list closed before `browser_snapshot` captured the tree, the engine returned `matched: false`, falsely failing a valid interaction.

### Architectural Solution
- **Live DOM Value Extraction:** Every fill/select action reads `.value`, `.innerText`, and `aria-valuenow` directly from the DOM before confirming delivery.
- **Distinction Between Uncheckable vs. Real Mismatches:** Differentiating between snapshot capture gaps and genuine product assertions.

---

## 6. Infrastructure & Process Lifecycle Issues

### The Symptom
1. *"Server is temporarily unreachable. Please check your connection"* on the Sign-in page.
2. Backend crashing upon querying `RunResult`.

### Root Cause Analysis
1. **Prisma Client Drift:** Backend client (`server/node_modules/.prisma/client`) was out of sync with root schema, throwing validation errors on `failureExplanation`.
2. **Loopback Dual-Stack Resolution:** Node listening on `'0.0.0.0'` failed to accept connections from Chrome resolving `localhost` to IPv6 `::1`.

### Architectural Solution
- Synced server Prisma client via `scripts/sync-server-prisma.cjs`.
- Changed `server.listen(PORT)` to bind dual-stack so `localhost` and `127.0.0.1` work seamlessly.

---

## Summary of Action Items & Roadmap

| Area | Status | Next Milestone |
|---|---|---|
| **Universal DOM Engine** | Implemented (`universalDomEngine.js`) | Expand automated unit test coverage for complex shadow-DOM trees. |
| **Overlay Auto-Dismissal** | Implemented | Add multi-select tag/chip popup dismissal handlers. |
| **Execution Latency** | Optimized (Fast In-Page evaluate) | Eliminate remaining redundant snapshot captures. |
| **Self-Healing KB Memory** | Architecture Defined | Auto-update authored test case definitions in DB when healed. |
| **Visual Supervisor** | Integrated | Enable inline screenshot diffing during long form execution. |

---
*Report compiled and certified for QAAI Portal Autonomous Quality Intelligence.*
