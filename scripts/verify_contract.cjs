'use strict';
/**
 * Enterprise Mode P1 guard — the canonical test-case contract.
 *   node scripts/verify_contract.cjs
 *
 * [1] assertContractComplete() — the completeness gate's logic.
 * [2] persistCases() writes the FULL contract field set (no field dropped).
 * [3] Wiring — scenarios.js (both sites) + agents.js persist through the ONE
 *     canonical writer; the old divergent inline creates are gone.
 *
 * No DB, no LLM. Deterministic.
 */
const fs = require('fs');
const path = require('path');
const tcc = require('../server/services/testCaseContract');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

console.log('\n[1] assertContractComplete — completeness gate');

// Healthy automatable case → ok.
let r = tcc.assertContractComplete({
  automatability: 'automatable',
  declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'doc_quoted' }],
});
assert(r.ok && r.violations.length === 0, 'automatable case with a valid must → ok');

// No declared assertions at all → violation.
r = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [] });
assert(!r.ok && r.violations.includes('no_declared_assertions'), 'automatable case with NO assertions → no_declared_assertions');

// Only parseFailed placeholders → still "no real assertions".
r = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', parseFailed: true }] });
assert(!r.ok && r.violations.includes('no_declared_assertions'), 'parseFailed-only → no_declared_assertions (placeholders are not real checks)');

// Has assertions but none are must → violation.
r = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'should' }] });
assert(!r.ok && r.violations.includes('no_must_assertion'), 'assertions but no must → no_must_assertion (case would prove nothing)');

// Invalid assertion type → violation.
r = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'BOGUS', criticality: 'must' }] });
assert(!r.ok && r.violations.includes('invalid_assertion_type'), 'unknown assertion type → invalid_assertion_type');

// A must whose expected value originates from the live app → violation (anti-circular).
r = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'website' }] });
assert(!r.ok && r.violations.includes('must_provenance_app_origin'), 'must with app-origin provenance → must_provenance_app_origin (atlas never overrides business truth)');

// Manual case is exempt (verdict layer bypassed).
r = tcc.assertContractComplete({ automatability: 'manual', declaredAssertions: [] });
assert(r.ok, 'manual case with no assertions → ok (exempt)');

console.log('\n[2] persistCases — writes the FULL contract field set');
const mod = read('server', 'services', 'testCaseContract.js');
for (const field of ['declaredAssertions:', 'businessRisk:', 'producesData:', 'requiresData:', 'dataBindingJson:', 'generationId:', 'module:', 'automatability:']) {
  assert(mod.includes(field), `canonical writer persists ${field.replace(':', '')}`);
}
assert(/normalizeForCase\(/.test(mod), 'canonical writer normalizes declaredAssertions');
assert(/groundCaseAssertions\(/.test(mod), 'canonical writer runs the grounding gate when an atlas is present');
assert(typeof tcc.persistCases === 'function' && typeof tcc.assertContractComplete === 'function', 'module exports persistCases + assertContractComplete');

console.log('\n[3] Wiring — one canonical path, divergence removed');
const scn = read('server', 'routes', 'scenarios.js');
const agt = read('server', 'routes', 'agents.js');
assert((scn.match(/testCaseContract'\)\.persistCases\(/g) || []).length >= 2, 'scenarios.js persists BOTH sites (full + regenerate) through persistCases');
assert(/testCaseContract'\)\.persistCases\(/.test(agt), 'agents.js (all-in-one path) persists through persistCases');
// The old inline writes are gone — the divergence is structurally removed.
assert(!scn.includes('declaredAssertions: encodeJson(declaredResult.normalized)'), 'scenarios.js no longer has an inline declaredAssertions create (centralized)');
assert(!agt.includes('projectId: project.id, scenarioId: scenario.id, name: c.name, type: c.type,'), 'agents.js no longer has the divergent partial testCase.create');

console.log('\n[4] requirementOracle — deterministic core (P2)');
const oracle = require('../server/services/requirementOracle');

const id1 = oracle.computeRequirementId('BRD', 'User must be able to log in.');
const id2 = oracle.computeRequirementId('BRD', 'User   must be able to log in.'); // extra whitespace
const id3 = oracle.computeRequirementId('BRD', 'User must be able to log out.');
assert(id1.startsWith('REQ-') && id1 === id2, 'requirement id is content-addressed + whitespace-stable (re-upload → same id)');
assert(id1 !== id3, 'different requirement text → different id');
assert(oracle.computeRequirementId('USER_STORY', 'User must be able to log in.') !== id1, 'sourceType is part of the id');

const src = 'The system shall lock the account after 3 failed attempts.';
let v = oracle.verifyExcerpt('lock the account after 3 failed attempts', src);
assert(v.ok && v.spanStart > 0 && v.spanEnd > v.spanStart, 'verbatim excerpt → verified with a real source span');
assert(!oracle.verifyExcerpt('locks accounts after three failures', src).ok, 'paraphrased excerpt (not in source) → rejected (no fabricated traceability)');
v = oracle.verifyExcerpt('lock   the account', 'please lock the account now');
assert(v.ok && v.normalized === true, 'whitespace-variant excerpt → matched via a bounded normalized span');

const dm = oracle.dedupeAndMerge([
  { id: 'REQ-x', sourceType: 'BRD', sourceDocId: 'd1', excerpt: 'a', behaviourText: 'a' },
  { id: 'REQ-x', sourceType: 'USER_STORY', sourceDocId: 'd2', excerpt: 'a', behaviourText: 'a' },
  { id: 'REQ-y', sourceType: 'BRD', sourceDocId: 'd1', excerpt: 'b', behaviourText: 'b' },
]);
assert(dm.requirements.length === 2 && dm.mergedCount === 1, 'duplicate clause id collapses to ONE requirement (cross-ref, not duplicated)');
const merged = dm.requirements.find((r) => r.id === 'REQ-x');
assert(merged && merged.sourcesJson && JSON.parse(merged.sourcesJson).length === 1, 'merged clause preserves the other source under sourcesJson');

const byId = new Map(dm.requirements.map((r) => [r.id, r]));
assert(oracle.buildConflictFindings([{ aId: 'REQ-x', bId: 'REQ-y', detail: 'x' }], byId).length === 1, 'conflict between two real clauses → a requirement_conflict finding');
assert(oracle.buildConflictFindings([{ aId: 'REQ-x', bId: 'REQ-ghost' }], byId).length === 0, 'conflict referencing an unknown clause is dropped (no invented oracle rows)');

const rtm = oracle.buildRTM(
  [{ id: 'REQ-x' }, { id: 'REQ-y' }, { id: 'REQ-z', coverageDisposition: 'manually_excluded' }],
  [{ caseId: 'tc1', requirementRefs: ['REQ-x'] }],
);
const byReq = new Map(rtm.matrix.map((m) => [m.id, m.disposition]));
assert(byReq.get('REQ-x') === 'covered', 'requirement referenced by a case → covered');
assert(byReq.get('REQ-y') === 'uncovered' && rtm.uncovered.includes('REQ-y'), 'unreferenced requirement → uncovered');
assert(byReq.get('REQ-z') === 'manually_excluded', 'explicit human disposition stands (not overridden)');
assert(rtm.findings.some((f) => f.kind === 'requirement_uncovered'), 'uncovered requirement emits a finding (no orphan requirements)');

console.log('\n[5] assertContractComplete — P2 traceability (inert by default)');
assert(tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must' }] }).ok, 'no_requirement_ref NOT raised by default (inert until the oracle is wired in)');
let g = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must' }], requireRequirementRefs: true, requirementRefs: [] });
assert(!g.ok && g.violations.includes('no_requirement_ref'), 'requireRequirementRefs + no refs → no_requirement_ref (no orphan cases)');
assert(tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must' }], requireRequirementRefs: true, requirementRefs: ['REQ-x'] }).ok, 'requireRequirementRefs + a ref → ok');

console.log('\n[6] Schema + migration (P2, additive)');
const schemaSrc = read('prisma', 'schema.prisma');
assert(/model RequirementClause \{/.test(schemaSrc), 'RequirementClause model added');
assert(/requirementRefs\s+String\?/.test(schemaSrc), 'TestCase.requirementRefs column added');
const migP2 = path.join(__dirname, '..', 'prisma', 'migrations', '20260609000000_add_requirement_oracle', 'migration.sql');
const migSql = fs.existsSync(migP2) ? fs.readFileSync(migP2, 'utf8') : '';
assert(/CREATE TABLE "RequirementClause"/.test(migSql) && /ADD COLUMN "requirementRefs"/.test(migSql), 'migration creates RequirementClause + adds requirementRefs (additive)');

console.log('\n[7] requirementContext — Hybrid clause index + deterministic retrieval (P2-integration)');
const rc = require('../server/services/requirementContext');
const sampleClauses = [
  { id: 'REQ-aaa', sourceType: 'BRD', behaviourText: 'Account locks after three failed login attempts', excerpt: 'the system shall lock the account after three (3) failed login attempts' },
  { id: 'REQ-bbb', sourceType: 'USER_STORY', behaviourText: 'Admin can create a new employee record in PIM', excerpt: 'As an admin I can create a new employee record' },
  { id: 'REQ-ccc', sourceType: 'RELEASE_NOTE', behaviourText: 'Session expires after fifteen minutes idle', excerpt: 'session expires after 15 minutes of inactivity' },
];
const idx = rc.buildClauseIndex(sampleClauses, { knownModules: ['PIM'] });
assert(idx.length === 3 && idx.every((r) => r.requirementId && r.sourceType && r.behaviourText), 'clause index rows carry requirementId + sourceType + behaviourText');
assert(idx.every((r) => !('excerpt' in r) && !('spanStart' in r) && !('span' in r)), 'clause index NEVER carries the raw excerpt/span (verbatim source stays server-side — data minimization)');
assert(idx.some((r) => r.moduleHint === 'PIM'), 'moduleHint derived ONLY when a known module name actually appears in the text');
assert(!idx.find((r) => r.requirementId === 'REQ-aaa').moduleHint, 'a clause with no known-module match gets NO moduleHint (honest absence, no fabrication)');

const built = rc.buildArchitectClauseBlock(sampleClauses, { scopeText: 'login lock account', knownModules: ['PIM'], withSnippets: true, maxSnippets: 1, maxSnippetChars: 40 });
assert(built && built.block && built.clauseIdSet instanceof Set, 'buildArchitectClauseBlock returns a prompt block + authoritative clauseIdSet');
assert(built.clauseIdSet.size === 3 && built.clauseIdSet.has('REQ-aaa'), 'clauseIdSet is the full indexed id set (what Node validates refs against)');
assert(built.stats.snippetCount <= 1, 'snippet attachment respects the maxSnippets cap');
assert(!built.block.includes('the system shall lock the account after three (3) failed login attempts'), 'the FULL excerpt never leaks into the block — only a capped snippet may appear');
assert(rc.buildArchitectClauseBlock([], {}) === null, 'no clauses → null block (legacy additive path stays unchanged)');

console.log('\n[7b] markRequirementRefs — Node disposes (invented refs stripped, case union computed)');
const architect = require('../server/services/agents/architect');
const clauseIdSet = new Set(['REQ-aaa', 'REQ-bbb']);
const parsedTC = [{ cases: [{ name: 'c1', declaredAssertions: [
  { type: 'TEXT', criticality: 'must', requirementRefs: ['REQ-aaa', 'REQ-GHOST'] },
  { type: 'URL', criticality: 'should', requirementRefs: ['REQ-bbb'] },
  { type: 'TEXT', criticality: 'must' },
] }] }];
const mstats = architect.markRequirementRefs(parsedTC, clauseIdSet);
const a0 = parsedTC[0].cases[0].declaredAssertions[0];
assert(a0.requirementRefs.length === 1 && a0.requirementRefs[0] === 'REQ-aaa', 'invented ref (REQ-GHOST) stripped — only the real clause id survives');
assert(mstats.inventedRefsStripped === 1, 'invented-ref strip is counted (the LLM cannot invent ids)');
assert(Array.isArray(parsedTC[0].cases[0].requirementRefs) && parsedTC[0].cases[0].requirementRefs.includes('REQ-aaa') && parsedTC[0].cases[0].requirementRefs.includes('REQ-bbb'), 'case-level union computed from verified refs (→ TestCase.requirementRefs)');
assert(mstats.mustWithoutRef === 1, 'a "must" with no valid ref is counted as a coverage gap (surfaced, never auto-failed)');
assert(architect.markRequirementRefs(parsedTC, new Set()).casesTraced === 0, 'empty clause set → no-op (legacy generations untouched)');

// The case-level union must SURVIVE normaliseCase → persistCases (the field-
// stripping regression class this project has hit before). Full chain:
const rawCase = { name: 'trace-case', type: 'functional', confidence: 80, declaredAssertions: [{ type: 'TEXT', criticality: 'must', requirementRefs: ['REQ-aaa'] }] };
architect.markRequirementRefs([{ cases: [rawCase] }], new Set(['REQ-aaa']));
const normalised = architect.normaliseCase(rawCase);
assert(Array.isArray(normalised.requirementRefs) && normalised.requirementRefs.includes('REQ-aaa'), 'normaliseCase PRESERVES the case-level requirementRefs (survives into persistCases → TestCase.requirementRefs)');

console.log('\n[7c] dlpEgress — egress gate (deny ⇒ no body egress)');
const dlp = require('../server/lib/dlpEgress');
assert(dlp.isProviderEgressAllowed('claude', { allowEnv: '' }) === true, 'no policy configured → egress allowed (hook inert, backward compatible)');
assert(dlp.isProviderEgressAllowed('claude', { allowEnv: 'claude,gemini' }) === true, 'provider on the allow-list → permitted');
assert(dlp.isProviderEgressAllowed('gemini', { allowEnv: 'claude' }) === false, 'provider NOT on the allow-list → DENIED (caller falls back to deterministic, no-egress extraction)');
const disp = dlp.egressDisposition('gemini', { allowEnv: 'claude' });
assert(disp.allowed === false && disp.policyConfigured === true && /DENIED/.test(disp.reason), 'egressDisposition gives a structured deny reason for the audit log');

console.log('\n[7d] Wiring — every generation path feeds the oracle (no divergence)');
const scn2 = read('server', 'routes', 'scenarios.js');
const agt2 = read('server', 'routes', 'agents.js');
const arch2 = read('server', 'services', 'agents', 'architect.js');
assert(/prepareArchitectClauses\(/.test(scn2), 'scenarios.js calls prepareArchitectClauses (extraction + DLP gate + mode)');
assert(/requirementClauses:\s*clausePrep\.requirementClauses/.test(scn2), 'scenarios.js passes requirementClauses into architect.run');
assert(/persistRtmFindings\(/.test(scn2), 'scenarios.js builds the RTM (uncovered-requirement findings)');
assert(/prepareArchitectClauses\(/.test(agt2), 'agents.js all-in-one path also feeds the oracle (canonical, no divergence)');
assert(/markRequirementRefs\(parsed/.test(arch2), 'architect.js validates requirementRefs after parse (Node disposes)');
assert(/Do NOT invent a requirement id/.test(arch2), 'architect prompt forbids inventing requirement ids');
assert(/contextMode === 'hybrid'/.test(arch2), 'architect.js implements the Hybrid (data-minimized) context path');

console.log(`\n${failures === 0 ? 'PASS — canonical contract + requirements oracle + P2-integration enforced' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
