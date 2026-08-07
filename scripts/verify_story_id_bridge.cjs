'use strict';
/*
 * STEP 3B BRIDGE — the case↔workbook storyId join key. Locks the generic story-id
 * extractor + the persistence/propagation wiring (RequirementClause.storyId,
 * TestCase.storyId derived from requirementRefs; mixed refs → ambiguous). Generic
 * — never a site/OrangeHRM format. Pure for the extractor; source-level for wiring.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server', 'lib', 'storyId'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— generic story-id extraction (no site-specific format) —');
ok('US-OHRM-001 (multi-segment structured)', S.extractStoryId('As a user… (US-OHRM-001)') === 'US-OHRM-001');
ok('US-123 (simple structured)', S.extractStoryId('Covers US-123 login') === 'US-123');
ok('STORY-ABC-001', S.extractStoryId('STORY-ABC-001: the user can…') === 'STORY-ABC-001');
ok('ST-7', S.extractStoryId('ref ST-7') === 'ST-7');
ok('"User Story 12" → US-12', S.extractStoryId('User Story 12 — login') === 'US-12');
ok('"Story 12" → US-12', S.extractStoryId('Story 12: reset password') === 'US-12');
ok('"US 12" / "US#12" → US-12', S.extractStoryId('US 12') === 'US-12' && S.extractStoryId('see US#12') === 'US-12');
ok('plain prose with no story id → null', S.extractStoryId('The user logs in and sees the dashboard.') === null);
ok('prefers a story-ish prefix over an incidental structured token', S.extractStoryId('per RFC-2 the story US-OHRM-009 applies') === 'US-OHRM-009');

console.log('\n— doc-heading recovery (the id lives in a section heading, not the atomic clause) —');
{
  const doc = 'US-OHRM-004  PIM module\nThe user can add an employee.\n\nUS-OHRM-005  Leave module\nThe user can apply for leave and see it listed.';
  const clauseSpan = doc.indexOf('The user can apply'); // a clause under US-OHRM-005
  ok('storyIdNear recovers the OWNING heading (nearest at/before the span)', S.storyIdNear(doc, clauseSpan) === 'US-OHRM-005', S.storyIdNear(doc, clauseSpan));
  const firstClauseSpan = doc.indexOf('The user can add'); // under US-OHRM-004
  ok('storyIdNear picks the correct preceding heading for an earlier clause', S.storyIdNear(doc, firstClauseSpan) === 'US-OHRM-004', S.storyIdNear(doc, firstClauseSpan));
  ok('storyIdNear → null when no heading precedes the span', S.storyIdNear('plain intro text with no story id\nclause body', 40) === null);
}

console.log('\n— normalization + matching —');
ok('normalize: lower/space/underscore → canonical', S.normalizeStoryId('us_ohrm 001') === 'US-OHRM-001');
ok('storyIdsMatch is normalized + symmetric', S.storyIdsMatch('US-OHRM-001', 'us-ohrm-001') && !S.storyIdsMatch('US-OHRM-001', 'US-OHRM-002'));
ok('match needs both present (null never matches)', !S.storyIdsMatch(null, 'US-1') && !S.storyIdsMatch('US-1', ''));

console.log('\n— WIRING: storyId persisted on clause + derived onto the case —');
const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
ok('RequirementClause.storyId column exists (nullable)', /model RequirementClause[\s\S]*?storyId\s+String\?/.test(schema));
ok('TestCase.storyId column exists (nullable)', /model TestCase[\s\S]*?storyId\s+String\?/.test(schema));
const oracleSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'requirementOracle.js'), 'utf8');
ok('requirementOracle extracts + persists clause storyId', oracleSrc.includes("require('../lib/storyId')") && /storyId(:|\s*=)/.test(oracleSrc) && oracleSrc.includes('extractStoryId'));
const tccSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'testCaseContract.js'), 'utf8');
ok('persistCases derives TestCase.storyId from requirementRefs', tccSrc.includes('storyId') && /requirementRefs/.test(tccSrc));
ok('mixed requirementRefs → ambiguous_story_ids (not a silent guess)', tccSrc.includes('ambiguous_story_ids'));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — storyId bridge: generic extraction, normalized matching, persisted on RequirementClause + derived onto TestCase (mixed refs flagged ambiguous, never guessed).');
