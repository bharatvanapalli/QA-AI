# QAAI — Quality Analyst AI · Executive Demo Script

Target audience: VP of QA, CTO, QA Manager. **Not** an engineering crowd — they want the car, not the engine.

Total runtime if read straight: ~12 minutes. The nine internal agents collapse into three roles (Designer / Driver / Judge) so the architecture sounds simple, not brittle. Token cost is called out beside each role so the buyer can map architecture → invoice.

---

## 1. The Hook · ~1 min

> "Hi everyone. I'm going to walk you through **QAAI — Quality Analyst AI**.
>
> Every QA team has the same problem: feature velocity outpaces test coverage. By the time a senior SDET writes test cases for sprint N, the team is shipping sprint N+1.
>
> The current market — Mabl, Functionize, TestSprite, DevAssure — gives you better recorders and self-healing for tests **you already wrote**. They still need the test cases to exist. They still need a human to keep up with the application.
>
> QAAI takes the next step. **You upload the BRD. We write the tests, run them, and verdict them.** Your QA lead's job moves from authoring to reviewing."

---

## 2. The ROI · ~1 min (numbers first, before they ask)

> "Concrete numbers, because that's what budget owners want.
>
> | Task | Manual | QAAI |
> | --- | --- | --- |
> | Scenario authoring from a BRD | 4–6 hrs (senior SDET) | **~90 seconds** |
> | Execution of 20 approved cases | 6–8 hrs (junior SDET) | **~25 minutes** |
> | Per-case RCA writing | 2–3 hrs | **automatic** |
> | **Total wall-clock** | **~1 working day, 2 people** | **~90 minutes, 1 reviewer** |
>
> Per-run cloud cost: **$1.50–$3 fast mode, $3–$5 thorough mode** in Claude tokens (BYOK — you bring your own key, we don't markup).
>
> A senior SDET's loaded day-rate covers ~200 QAAI runs. The compute isn't the moat — the architecture is."

---

## 3. The Architecture in Three Roles · ~3 min

> "QAAI is nine cooperating agents under the hood, but they group cleanly into three roles. I'll keep this short — the more interesting part is the kill-shot in slot 4."

### 🎨 The DESIGNER · *reads requirements, writes the test plan*

> **Token spend per run: ~15K tokens (~$0.05)**
>
> "Reads your BRD, release notes, user stories. Returns a structured test plan: scenarios, cases, typed assertions, manual-vs-automatable classification.
>
> Built from two cooperating components:
> - **Author** (Claude Sonnet 4.6) — produces the scenario JSON.
> - **Planner** (pure Node, zero LLM) — topological-sorts cases by dependency into execution waves. Graph algorithms are solved problems; we don't burn tokens on them.
>
> Where the Designer is strict:
> - **Typed assertions only** — TEXT, URL, ROLE, DOWNLOAD, FORBIDDEN_TEXT. Not prose.
> - **URL grounding rule** — if the BRD doesn't cite `/dashboard`, the Designer can't *guess* `/dashboard`. Convention-guessing was the single biggest false-fail source.
> - **Reachability self-check** — every declared assertion must be reachable by the case's steps. Caught at authoring, not at runtime.
> - **Manual classification** — compliance sign-offs, OTPs delivered to personal phones, visual brand-fidelity get flagged manual and excluded from automation."

### 🚗 The DRIVER · *executes the plan against a live browser*

> **Token spend per run: ~1.2M tokens (~$1.50 fast) · ~1.5M (~$3 thorough)** — the heaviest role, where 90% of compute lives.
>
> "Drives a real Playwright browser through the approved cases. This is the workhorse.
>
> Built from three cooperating components:
> - **Conductor** (Claude Sonnet 4.6 in a tool-use loop) — calls real Playwright primitives: click, type, snapshot, navigate, evaluate.
> - **Critic** (inline Claude check) — watches every turn, blocks a wrong pass-claim, detects loops and browser death. *Fast mode only fires on errors; thorough mode runs every turn.*
> - **Healer** (mostly deterministic) — recovers broken selectors from the KB **before Claude even sees the error**. Most drift is silent — zero tokens.
>
> What the Driver does that competitors don't:
> - **Project KB primes every prompt.** The Driver doesn't re-discover locators each run — it starts from prior runs' learning.
> - **Defensive popup wrapping in generated code** — reruns won't crash on days the popup doesn't appear.
> - **Three-layer assertions in the generated Playwright** — UI (`toBeVisible`), DOM attribute (`toHaveAttribute`), network (`waitForResponse`)."

### ⚖️ The JUDGE · *decides pass / fail / blocked / needs_human*

> **Token spend per run: ~0 tokens for the verdict itself.** Reporter writes per-failure narrative at ~7K/failure.
>
> "After the Driver finishes, the Judge takes over. **The Judge is deterministic code, not an LLM. It cannot hallucinate a verdict.**
>
> Built from three cooperating components:
> - **Post-loop Ratifier** — fills in any declared assertion the Driver didn't check. Uses synthetic snapshot checks. **Zero LLM calls.**
> - **Verdict Layer** — pure-function priority ladder. Inputs: declared assertions, step outcomes, cancellation flags, browser-death flags. Output: pass / fail / blocked / needs_human. **Zero LLM calls.**
> - **Reporter** (Claude) — writes the AI Analysis narrative for failing cases. The *only* LLM call in this role, and it's purely descriptive — it cannot override the verdict.
>
> More on why this matters in the next slot — it's the single most important architectural decision in the system."

---

## 4. The Kill-Shot: Deterministic Verdict · ~2 min

> "I want to dwell on this because it's the difference between QAAI and every other AI-QA tool in the market.
>
> **Every other AI test platform lets the LLM grade its own homework.** The agent runs the test, the agent decides whether it passed. The agent's incentive to look productive overwhelms its incentive to be honest. We saw 25 false passes in a single run when we first built it that way.
>
> **We ripped the LLM out of the final decision.** Pass/fail is now computed by deterministic code — a priority ladder:
>
> 1. User cancelled → `user_cancelled`
> 2. Browser died → `blocked(session_dead)`
> 3. Any step failed → `fail` or `blocked`
> 4. Any declared assertion `not_matched` → `fail`. Only `uncheckable` outcomes → `needs_human`. All matched → `pass`.
> 5. Hit the turn ceiling without a clean end → `blocked(turn_ceiling)`
>
> The verdict layer is a pure function in [`server/services/computeVerdict.js`](server/services/computeVerdict.js). If the LLM tries to claim pass, the verdict layer ignores it. **The report cannot lie.**
>
> If you remember one thing from this presentation: **QAAI is the end of AI-hallucinated test results.** Every other tool in this space gives you 'the AI thinks it passed.' We give you 'a deterministic priority ladder decided it passed, and here is the evidence.'"

---

## 5. The Live Demo · ~4 min

> "Let me show you the actual product. I'll walk through one project, start to finish."

**Suggested click-path (~4 min driving the UI live):**

1. **Project Setup** — *15 sec.* Show: target URL, API key field, the Known Popups editor, the fast/thorough toggle.
2. **Test Cases** — *30 sec.* Show approved cases with typed declared assertions visible (`TEXT`, `URL`, `FORBIDDEN_TEXT`). Highlight that these came from the BRD, not from a recorder.
3. **Live Pipeline · click Start Run** — *2 min while it executes.* Narrate:
   - Pipeline animation at the top — Designer ✓, Driver running, Judge waiting.
   - **Now Testing** strip — the real test case name and step counter.
   - **Action Trail** — human-language narration ("Clicked the Login button"), not raw tool names.
   - **Top counters** — Actions this run, Estimated cost, Tokens this run (monotonic, no flapping).
4. **Reports** — *60 sec.* Open a passed case + a failed case + a needs_human case. On the failed one, open the AI Analysis tab — point out that the *narrative* came from the LLM but the *verdict* came from the code priority ladder.
5. **Output Files** — *30 sec.* Open a generated `.spec.ts`. Stress: "This is real Playwright code. If you fire us tomorrow, you keep the code."

---

## 6. The Moat: Self-Healing Knowledge Base · ~1 min

> "One more thing buyers care about: does this get smarter, or does it stay the same on day 90?
>
> Every successful locator the Driver uses is recorded into the project's Knowledge Base: accessible name, role, page URL, occurrences, health score. Three things happen with that knowledge:
>
> 1. **Next run starts with the top 50 locators pre-loaded into the Driver's prompt.** Less re-discovery, fewer tokens, faster runs.
> 2. **When a locator stops resolving, the Healer tries the KB alternatives before Claude is told there's an error.** Most selector drift is recovered silently.
> 3. **Locators below a health threshold get quarantined.** The Driver refuses to use them and surfaces a blocker for human review.
>
> So **run N+1 is measurably cheaper than run N for the same project.** Mabl-style competitors self-heal one selector at a time. We accumulate a project-wide brain. That compounds."

---

## 7. Honest Compromises + Modes · ~1 min

> "What we compromised on, because budgets are real:
>
> - Designer output capped at 12 scenarios × 4 cases per run. Very large BRDs need scoping into multiple runs. Configurable per-project is on the roadmap, not shipped.
> - Snapshot truncated to 20KB before Claude sees it.
> - Periodic inline-Critic dropped in fast mode (saves ~50K tokens/case).
>
> **Two execution modes for two use cases:**
>
> | Mode | When to use | Cost | Confidence |
> | --- | --- | --- | --- |
> | **Fast** (default) | Daily smoke runs | $1.50–$3 | High |
> | **Thorough** | Pre-release sign-off | $3–$5 | Highest |
>
> Thorough adds Supervisor (re-plans persistently failing cases with operator-quality guidance) and inline Critic on every turn.
>
> What we **don't** do yet:
> - Cross-organization shared learning (KB is per-project).
> - Mobile / native app testing — Playwright web only.
> - Self-hosted on-prem — BYOK + SQLite/Postgres + the agent code is yours to deploy."

---

## 8. The Handoff · ~30 sec

> "Two closing points.
>
> **First:** QAAI generates **native Playwright TypeScript** as a deliverable. Real Page Objects, real `test()` blocks, real assertions. If you decide to stop paying us, you keep every test case we authored — they run in your CI pipeline without QAAI. You own your IP.
>
> **Second** — and this is the line I want you to remember:
>
> *Every other tool in this space wants you to maintain test cases. QAAI maintains them for you. Your QA lead's job moves from writing the tests to reviewing the verdicts.*
>
> Happy to take questions."

---

## Token Cost Cheat-Sheet (for Q&A)

Be ready to defend these numbers. They're per a typical 20-case, ~30%-fail run.

| Component | Role | Fast tokens | Thorough tokens | Notes |
| --- | --- | --- | --- | --- |
| Author (Architect) | Designer | ~15K | ~15K | One Claude call per BRD, capped at 20K output. |
| Planner | Designer | 0 | 0 | Pure Node, topological sort. |
| Conductor | Driver | ~1.0M | ~1.2M | The workhorse. ~50K / case × 20 cases. |
| Critic (inline) | Driver | ~30K | ~300K | Fast: only on errors. Thorough: every turn. |
| Healer | Driver | ~0–5K | ~0–5K | Mostly deterministic KB lookup. |
| Post-loop Ratifier | Judge | 0 | 0 | Synthetic snapshot checks, no LLM. |
| Verdict Layer | Judge | 0 | 0 | Pure function. |
| Supervisor | Judge | 0 | ~150K | Thorough-only, fires on persistently failing cases. |
| Reporter | Judge | ~30K | ~30K | ~7K per failing case × ~5 failures. |
| InstructionReader | Driver | 0 | 0 | Only fires when human pauses run. |
| **Total** | | **~1.1M** | **~1.7M** | **~$1.50–$3 fast · ~$3–$5 thorough** |

Pricing assumed: Sonnet 4.6 at $3/MTok input, $15/MTok output, with system-prompt caching at $0.30/MTok cache hits (~60% of Driver input hits cache after the first turn of each case).

---

## Anticipated Q&A

- *"Why nine agents? Sounds brittle."* — They're not nine independent services; they're nine cooperating roles in one process. Grouped into three responsibilities. Failure modes are isolated and well-typed (cancelled / session_died / step_failed / assertion_not_matched / turn_ceiling) — the verdict layer can't drop a case on the floor.
- *"What stops the LLM from hallucinating a pass?"* — The verdict is computed by deterministic code. The LLM can claim pass; the verdict layer reads the declared assertions and the recorded outcomes and decides independently. If the agent didn't check an assertion, the Post-loop Ratifier checks it. If a check failed, the verdict is fail — the LLM cannot override it.
- *"What's the cost at scale — 1,000 cases / day?"* — Roughly $75–$150 / day in fast mode at the volumes we've measured. The KB makes each subsequent run cheaper for the same project, so steady-state is lower than first-run.
- *"How is this different from Mabl / Functionize?"* — They start from a recorded session. We start from requirements. They self-heal one selector at a time; we accumulate a project-wide KB that primes every future run.
- *"Can it test our internal app behind SSO?"* — Yes. Per-project browser-context config supports HTTP credentials, custom headers, geolocation, color-scheme, viewport, user agent. Configurable in Project Setup.
- *"What if a run fails halfway?"* — Partial results are persisted per-case. Cancel and rerun only the failed cases. Approval state is preserved across runs.
- *"Self-hosting?"* — Yes. BYOK for the LLM provider, SQLite for dev or Postgres for prod, the agent code deploys as a standard Node service. No vendor lock-in.
- *"What about Playwright Codegen — isn't that the same thing?"* — Codegen records what *a human did* in a browser. QAAI authors what *the requirements say*. Different starting point, different output. Codegen requires a human to drive the recording; QAAI requires only the BRD.

---

*Last updated: 2026-05-29*
