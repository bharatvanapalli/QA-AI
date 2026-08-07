'use strict';
// Detect COMPLEX-INTERACTION coverage in the current generation: dropdown/select, autocomplete/
// typeahead, date picker, checkbox/radio/toggle, and multi-field form submission. Read-only.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

(async () => {
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' } });
  const scenarios = await prisma.testScenario.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const cases = await prisma.testCase.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const byScn = new Map(); for (const c of cases) { if (!byScn.has(c.scenarioId)) byScn.set(c.scenarioId, []); byScn.get(c.scenarioId).push(c); }

  const tot = { dropdown: 0, autocomplete: 0, datePicker: 0, checkboxToggle: 0, multiField: 0, complexCases: 0 };
  console.log(`GENERATION v${gen.version} — complex-interaction coverage\n`);
  for (const s of scenarios) {
    for (const c of (byScn.get(s.id) || [])) {
      const steps = parse(c.steps) || [];
      const da = parse(c.declaredAssertions) || [];
      const txt = JSON.stringify({ steps, da }).toLowerCase();
      const verifyKinds = steps.map((st) => st.verify && st.verify.kind).filter(Boolean);
      const actions = steps.map((st) => String(st.action || '').toLowerCase());
      const fillCount = actions.filter((a) => /fill|type|enter|input/.test(a)).length;
      const tags = [];
      const dropdown = verifyKinds.includes('selected') || actions.some((a) => /select|choose|pick/.test(a)) || /dropdown|combobox|<select|\bselect a\b|option/.test(txt);
      const autocomplete = /autocomplete|typeahead|type ?ahead|suggestion|auto-?complete|start typing|select from the suggest/.test(txt);
      const datePicker = /date ?picker|calendar|datepicker|select a date|choose a date|\bcalendar\b/.test(txt) || /\bdate\b/.test(txt) && actions.some((a) => /pick|select|choose/.test(a));
      const checkboxToggle = verifyKinds.includes('checked') || /checkbox|radio button|toggle|switch on|tick the/.test(txt);
      const multiField = fillCount >= 3;
      if (dropdown) { tags.push('dropdown'); tot.dropdown++; }
      if (autocomplete) { tags.push('autocomplete'); tot.autocomplete++; }
      if (datePicker) { tags.push('date'); tot.datePicker++; }
      if (checkboxToggle) { tags.push('checkbox/toggle'); tot.checkboxToggle++; }
      if (multiField) { tags.push(`multi-field(${fillCount})`); tot.multiField++; }
      if (tags.length) { tot.complexCases++; console.log(`  • [${tags.join(', ')}] ${c.name}  (scn: ${s.name.slice(0, 40)})`); }
    }
  }
  console.log('\n════════ COMPLEX-INTERACTION SUMMARY ════════');
  console.log(`total cases=${cases.length} | complex cases=${tot.complexCases}`);
  console.log(`dropdown/select=${tot.dropdown} | autocomplete=${tot.autocomplete} | datePicker=${tot.datePicker} | checkbox/toggle=${tot.checkboxToggle} | multi-field-form=${tot.multiField}`);
  console.log(`\n  [${tot.dropdown > 0 && tot.multiField > 0 ? 'PASS' : 'FAIL'}] suite includes dropdown + multi-field-form interactions (not login-only)`);
  console.log(`  [${tot.autocomplete > 0 ? 'PASS' : 'WARN'}] suite includes autocomplete/typeahead`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
