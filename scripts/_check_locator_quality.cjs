'use strict';
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();
const RUN_ID = process.argv[2] || '8c75ee05-b9f5-4415-8568-6e1e592e4199';

// Inline copy of the locator quality checks from replayExport.js
function normalizeCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter(c => c && typeof c === 'object');
}
function locatorText(c) {
  return c.text || c.name || c.label || c.placeholder || c.selector || '';
}
function intrinsicallyBadCandidate(c) {
  const t = locatorText(c);
  return !t || /^https?:\/\//i.test(t) || t.length > 200 || /[\r\n]/.test(t);
}
function candidateMatchesValueRef(candidate, valueRef) {
  const vr = String(valueRef || '');
  const txt = locatorText(candidate).toLowerCase();
  const vrLower = vr.toLowerCase();
  return txt.length > 0 && (txt.includes(vrLower) || vrLower.includes(txt));
}

function assessLocators(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  const byAs = new Map();
  const findings = [];
  steps.forEach((step, index) => {
    if (step && step.op === 'resolve' && step.as) {
      byAs.set(step.as, { step, index, candidates: normalizeCandidates(step.candidates || []) });
    }
  });

  for (const entry of byAs.values()) {
    const candidates = entry.candidates || [];
    if (!candidates.length) {
      findings.push({ rule: 'no_candidates', as: entry.step.as, index: entry.index });
      continue;
    }
    if (candidates.every(intrinsicallyBadCandidate)) {
      findings.push({ rule: 'all_polluted', as: entry.step.as, index: entry.index,
        examples: candidates.map(locatorText).slice(0, 3) });
    }
  }

  for (const [index, step] of steps.entries()) {
    if (!step || step.op !== 'act' || !step.target || !step.valueRef) continue;
    const action = String(step.action || '').toLowerCase();
    if (!['fill', 'type', 'selectoption'].includes(action)) continue;
    const entry = byAs.get(step.target);
    if (!entry) continue;
    const candidates = (entry.candidates || []).filter(c => !intrinsicallyBadCandidate(c));
    if (!candidates.length) continue;
    const usable = candidates.filter(c => candidateMatchesValueRef(c, step.valueRef));
    if (!usable.length) {
      findings.push({ rule: 'value_pollution', as: step.target, actionIndex: index,
        valueRef: step.valueRef, candidates: candidates.map(locatorText).slice(0, 3) });
    }
  }

  return { ok: findings.filter(f => f.rule !== 'advisory').every(() => false) || findings.length === 0, findings };
}

(async () => {
  const results = await db.runResult.findMany({
    where: { runId: RUN_ID },
    select: { id: true, testCaseId: true, replayIrJson: true,
      testCase: { select: { name: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  let total = 0, ok = 0, blocked = 0;
  for (const r of results) {
    let envelope = null;
    try { envelope = r.replayIrJson ? JSON.parse(r.replayIrJson) : null; } catch (_) {}
    if (!envelope || !envelope.ir) continue;
    total++;
    const assessment = assessLocators(envelope.ir);
    if (!assessment.ok || assessment.findings.length > 0) {
      blocked++;
      const caseName = r.testCase && r.testCase.name || '(no name)';
      console.log(`\nFAILS LOCATOR GATE: "${caseName}"`);
      console.log(`  RunResult: ${r.id}  complete: ${envelope.complete}`);
      assessment.findings.forEach(f => console.log(`  [${f.rule}] as=${f.as || '?'} valueRef=${f.valueRef || ''} candidates=${JSON.stringify(f.candidates || f.examples || [])}`));
    } else {
      ok++;
    }
  }
  console.log(`\nTotal: ${total}  OK: ${ok}  Locator-blocked: ${blocked}`);
  await db.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
