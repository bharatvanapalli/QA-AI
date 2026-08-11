import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  Clipboard,
  FileText,
  Sparkles,
  Wand2,
} from 'lucide-react';

export const QAAI_AUTHORING_TEMPLATE = `# User Story: Create Inbound Freight Order
Module: Orders
Priority: P0

## Session & Dependency
Execution Mode: Fresh Session

## Test Data
| Dataset | Customer Name | Ship Direction | Password (Secret) |
| :--- | :--- | :--- | :--- |
| Primary | ACME Logistics | Inbound | {{env:USER_PASSWORD}} |
| Secondary | Global Freight | Outbound | {{env:USER_PASSWORD}} |

---

## Scenario 1: Successful Order Creation
Type: Functional

### Steps
1. Navigate to "https://app.example.com/orders/new"
   - Verify that "Order Entry Form" is visible.
2. Fill "Customer Name" with "{{Customer Name}}"
   - Verify that "Customer Name field" contains "{{Customer Name}}".
3. Select "{{Ship Direction}}" from "Ship Direction dropdown"
4. Click "Save Order button"
   - Verify that "Confirmation Toast" displays text "Order Successfully Created" [Must]
   - Verify that "Order Status field" displays "Created" [Must]`;

const ACTION_RE = /\b(open|navigate|visit|click|press|enter|fill|type|select|choose|check|uncheck|upload|download|hover|scroll|save|submit|login|log in|logout|log out)\b/i;
const ASSERTION_RE = /\b(verify|validate|assert|expect|confirm|ensure|should|must|displayed|visible|appears?)\b/i;
const DATA_RE = /\b([a-z][a-z0-9 _-]{1,32})\s*(?:=|:)\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi;
const TOKEN_RE = /\{\{[^{}]+\}\}/g;
const CASE_RE = /\b(test case|case|flow|journey|scenario)\s*(?:#|:|-|\d)/i;
const SCENARIO_RE = /\bscenario\s*(?:#|:|-|\d)/i;

function cleanLine(line) {
  return String(line || '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .trim();
}

function splitCandidateUnits(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return String(text || '')
    .split(/(?<=[.!?;])\s+|\s+(?:then|after that|next)\s+/i)
    .map(cleanLine)
    .filter(Boolean);
}

export function summarizeMessyFlow(text) {
  const source = String(text || '').trim();
  if (!source) {
    return {
      scenarios: 0,
      cases: 0,
      steps: 0,
      dataValues: 0,
      assertions: 0,
      cues: [],
    };
  }

  const units = splitCandidateUnits(source);
  const scenarioHeadings = units.filter((unit) => SCENARIO_RE.test(unit)).length;
  const caseHeadings = units.filter((unit) => CASE_RE.test(unit)).length;
  const actionUnits = units.filter((unit) => ACTION_RE.test(unit));
  const assertionUnits = units.filter((unit) => ASSERTION_RE.test(unit));
  const actionCueCount = (
    source.match(/\b(open|navigate|visit|click|press|enter|fill|type|select|choose|check|uncheck|upload|download|hover|scroll|save|submit|login|log in|logout|log out)\b/gi)
    || []
  ).length;
  const assertionCueCount = (
    source.match(/\b(verify|validate|assert|expect|confirm|ensure|should|must|displayed|visible|appears?)\b/gi)
    || []
  ).length;
  const keyValueMatches = [...source.matchAll(DATA_RE)].length;
  const tokens = new Set(source.match(TOKEN_RE) || []);
  const inlineQuotedValues = new Set(
    actionUnits.flatMap((unit) => [...unit.matchAll(/["']([^"']{1,80})["']/g)].map((match) => match[1])),
  );
  const dataValues = Math.max(keyValueMatches, tokens.size, inlineQuotedValues.size);

  const cues = [];
  if (actionCueCount) cues.push(`${actionCueCount} action cue${actionCueCount === 1 ? '' : 's'}`);
  if (assertionCueCount) cues.push(`${assertionCueCount} validation cue${assertionCueCount === 1 ? '' : 's'}`);
  if (dataValues) cues.push(`${dataValues} inline data value${dataValues === 1 ? '' : 's'}`);
  if (!assertionCueCount) cues.push('QAAI will infer observable outcomes while generating');

  return {
    scenarios: Math.max(1, scenarioHeadings),
    cases: Math.max(1, caseHeadings || scenarioHeadings),
    steps: Math.max(1, actionCueCount || actionUnits.length || units.length),
    dataValues,
    assertions: assertionCueCount,
    cues,
  };
}

export function convertFlowToTemplate(text) {
  const source = String(text || '').trim();
  if (!source) return QAAI_AUTHORING_TEMPLATE;
  return `User Story:
As a [role],
I want to complete the following flow,
so that the expected business outcome is achieved.

Preconditions:
- [Add any required starting state]

Test Data:
- QAAI will extract inline values from the flow below.

Steps:
${source}

Expected Results:
- QAAI will interpret validation phrases such as verify, expect, confirm, and should.`;
}

function SummaryMetric({ value, label }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-bold tabular-nums text-ink-900">{value}</div>
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-500">{label}</div>
    </div>
  );
}

export default function AuthoringAssist({ value, onChange, disabled = false, onNotify }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const summary = useMemo(() => summarizeMessyFlow(value), [value]);
  const hasText = String(value || '').trim().length > 0;

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(QAAI_AUTHORING_TEMPLATE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      onNotify?.('QAAI format copied.');
    } catch {
      onChange?.(QAAI_AUTHORING_TEMPLATE);
      onNotify?.('The template was added to the editor.');
    }
  };

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-ink-200/70 bg-ink-50/55">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-white/70 focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50"
        aria-expanded={open}
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-700">
          <BookOpen className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink-900">Optional QAAI writing guide</span>
          <span className="block text-xs text-ink-500">Messy paragraphs are accepted. The format only improves consistency.</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-ink-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {hasText ? (
        <div className="border-t border-ink-200/70 bg-white/65 px-3.5 py-3" aria-live="polite">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink-700">
            <Sparkles className="h-3.5 w-3.5 text-accent-600" aria-hidden="true" />
            Early interpretation — generation can continue without confirming this
          </div>
          <div className="mt-2 grid grid-cols-5 gap-2">
            <SummaryMetric value={summary.scenarios} label="Scenario" />
            <SummaryMetric value={summary.cases} label="Case" />
            <SummaryMetric value={summary.steps} label="Steps" />
            <SummaryMetric value={summary.dataValues} label="Data" />
            <SummaryMetric value={summary.assertions} label="Checks" />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            {summary.cues.join(' · ')}
          </p>
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-ink-200/70 bg-white/75 px-3.5 py-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyTemplate}
              disabled={disabled}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-ink-200 bg-white px-3 text-xs font-semibold text-ink-700 transition hover:border-accent-200 hover:text-accent-700 focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50"
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy template'}
            </button>
            <button
              type="button"
              onClick={() => onChange?.(convertFlowToTemplate(value))}
              disabled={disabled}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-accent-200 bg-accent-50 px-3 text-xs font-semibold text-accent-700 transition hover:bg-accent-100 focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50"
            >
              {hasText ? <Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> : <FileText className="h-3.5 w-3.5" aria-hidden="true" />}
              {hasText ? 'Convert current flow' : 'Use guided template'}
            </button>
          </div>

          <div className="mt-3 grid gap-2.5 text-xs text-ink-600 sm:grid-cols-2">
            <div className="rounded-lg border border-ink-200/60 bg-white p-2.5">
              <span className="font-semibold text-ink-900 block mb-1">Actions:</span>
              <p className="text-ink-600 leading-relaxed">
                <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Navigate</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Fill</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Select</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Click</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Check</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Upload</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">Clear</code>, <code className="text-accent-700 bg-accent-50 px-1 py-0.5 rounded">PressKey</code>
              </p>
            </div>
            <div className="rounded-lg border border-ink-200/60 bg-white p-2.5">
              <span className="font-semibold text-ink-900 block mb-1">Validations & Gherkin:</span>
              <p className="text-ink-600 leading-relaxed">
                <code className="text-success-700 bg-success-50 px-1 py-0.5 rounded">Verify</code>, <code className="text-success-700 bg-success-50 px-1 py-0.5 rounded">Validate</code>, <code className="text-success-700 bg-success-50 px-1 py-0.5 rounded">Assert</code> · <span className="text-ink-700 font-medium">Given / When / Then / And</span>
              </p>
            </div>
            <div className="rounded-lg border border-ink-200/60 bg-white p-2.5 sm:col-span-2">
              <span className="font-semibold text-ink-900 block mb-1">Dynamic Test Data & Secrets:</span>
              <p className="text-ink-600 leading-relaxed">
                Use <code className="text-info-700 bg-info-50 px-1 py-0.5 rounded">{'{{Customer Name}}'}</code> to bind variables to dataset tables, and <code className="text-warn-700 bg-warn-50 px-1 py-0.5 rounded">{'{{env:PASSWORD}}'}</code> for environment secrets.
              </p>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            Tip: Indent <span className="font-semibold text-ink-700">- Verify ...</span> directly under a numbered step for immediate step-level verification.
          </p>
        </div>
      ) : null}
    </section>
  );
}
