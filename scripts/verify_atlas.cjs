'use strict';
/**
 * Enterprise Mode P3 guard — the role-aware atlas = the HOW oracle.
 *   node scripts/verify_atlas.cjs
 *
 * [1] capabilityVocabulary — the FROZEN SEAM (types, operators, operations,
 *     type→ops map, validators). The LLM may SELECT; Node owns the vocabulary.
 * [2] atlasCapabilities — the deterministic classifier, on calibrator-shaped
 *     ElementRecords (form / entity_collection / workflow_action / file).
 * [3] Selector discipline — a capability carries ONLY a durable, cross-session
 *     selector; a control reachable only by an ephemeral mcp ref is dropped.
 * [4] Calibrator wiring — classifyCapabilities is called per page over the wider
 *     CLASSIFIER_ROLES set; capabilitiesJson persists via a graceful pre-regen
 *     fallback; elementsJson stays interactive-only.
 * [5] Atlas is HOW-only — the anti-circular firewall: a `must` may NEVER take its
 *     expected value from the site/atlas (provenance 'atlas' → blocked). Ties P3
 *     back to the P2 contract.
 * [6] Schema + migration — the P3 slice substrate (module/authProfile/version/
 *     isCurrent/fingerprint/staleAt + capabilitiesJson), additive.
 * [7] P3b/P3c behavioral gates (drift→version++, stale/absent slice, wrong-role
 *     grounding block, RequirementSiteMismatch) — pending; substrate-only here.
 *
 * No DB, no LLM. Deterministic.
 */
const fs = require('fs');
const path = require('path');
const vocab = require('../server/lib/capabilityVocabulary');
const caps = require('../server/services/agents/atlasCapabilities');
const tcc = require('../server/services/testCaseContract');
const slice = require('../server/lib/atlasSlice');
const opPlan = require('../server/services/agents/operationPlan');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── Build calibrator-shaped ElementRecords. The calibrator marks durable
//    selectors verified:false (snapshot-derived, not click-proven) and appends
//    an ephemeral mcp-ref (verified:true, stability 0.3) LAST — exactly what
//    extractElements produces. The classifier must still prefer the durable one.
let _ref = 0;
const durable = (selector, stability = 0.92, strategy = 'role') => ({ selector, strategy, stability });
function el(role, name, durables, withRef = true) {
  const chain = durables.map((d) => ({ selector: d.selector, strategy: d.strategy, verified: false, stabilityScore: d.stability }));
  if (withRef) chain.push({ selector: `ref=e${++_ref}`, strategy: 'mcp-ref', verified: true, stabilityScore: 0.3 });
  chain.sort((a, b) => b.stabilityScore - a.stabilityScore);
  return { semanticLabel: `${role} "${name}"`, selectorChain: chain, ariaRole: role, parentContext: '' };
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] capabilityVocabulary — the frozen seam (Node owns it)');

const LOCKED_TYPES = ['form', 'table', 'list', 'search_filter_sort', 'menu', 'modal', 'file', 'workflow_action', 'entity_collection'];
assert(LOCKED_TYPES.every((t) => vocab.CAPABILITY_TYPES.includes(t)), 'CAPABILITY_TYPES contains the locked set (incl. the normalized entity_collection)');

const LOCKED_OPS = ['authenticateAs', 'navigateToModule', 'assertVisibleText', 'fillField', 'submitForm',
  'selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains', 'invokeAction', 'downloadFile'];
assert(LOCKED_OPS.every((o) => vocab.isOperation(o)), 'OPERATIONS contains every locked operation name (the BDD step-registry source of truth)');
assert(!vocab.isOperation('frobnicate'), 'an unknown operation name is NOT in the vocabulary (LLM cannot invent one)');

const ecOps = vocab.operationsForType('entity_collection');
assert(['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'].every((o) => ecOps.includes(o)),
  'entity_collection exposes select / rank / choose / assertTableContains');
assert(vocab.GLOBAL_OPS.every((o) => ecOps.includes(o)), 'every capability type also exposes the global ops (authenticateAs / navigateToModule / assertVisibleText)');

// criteria operators
assert(vocab.validateCriteria([{ field: 'price', operator: 'lt', value: 1000 }]).length === 0, 'valid criteria ([{field,operator,value}]) → no violations');
assert(vocab.validateCriteria([{ field: 'price', operator: 'cheaperThan', value: 1 }]).length > 0, 'unknown criteria operator → violation (finite operator set)');
assert(vocab.validateCriteria([]).length > 0, 'empty criteria → violation (a filter with no predicate is meaningless)');

// validateCapabilityRecord — the teeth
const goodForm = { type: 'form', name: 'Login form', operations: ['fillField', 'submitForm'], evidence: { submit: { selector: 'getByRole("button", { name: "Login" })' } }, elementRefs: ['e1'] };
assert(vocab.validateCapabilityRecord(goodForm).ok, 'a valid form record (ops ⊆ type, real selector) → ok');
assert(!vocab.validateCapabilityRecord({ ...goodForm, type: 'frobnicator' }).ok, 'unknown capability type → rejected');
assert(!vocab.validateCapabilityRecord({ ...goodForm, operations: ['rankByMin'] }).ok, 'operation not valid for the type (rankByMin on a form) → rejected');
assert(!vocab.validateCapabilityRecord({ ...goodForm, operations: ['summonDragon'] }).ok, 'operation not in the vocabulary → rejected (Node disposes)');
assert(!vocab.validateCapabilityRecord({ ...goodForm, operations: [] }).ok, 'no operations → rejected (an inert capability is unusable)');
assert(!vocab.validateCapabilityRecord({ ...goodForm, evidence: { submit: { selector: null } } }).ok,
  'evidence with a NULL selector value → rejected (key alone is not enough — the "no verified selector ⇒ unusable" teeth)');
assert(!vocab.validateCapabilityRecord({ ...goodForm, evidence: { submit: { label: 'Login' } } }).ok, 'evidence with no selector at all → rejected');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] atlasCapabilities — deterministic classifier (calibrator-shaped input)');
assert(typeof caps.classifyCapabilities === 'function' && typeof caps.bestSelector === 'function', 'module exports classifyCapabilities + bestSelector');

// A login form.
const loginForm = [
  el('textbox', 'Username', [durable('getByRole("textbox", { name: "Username" })')]),
  el('textbox', 'Password', [durable('getByRole("textbox", { name: "Password" })')]),
  el('button', 'Login', [durable('getByRole("button", { name: "Login" })', 0.95)]),
];
const formRes = caps.classifyCapabilities({ elements: loginForm, textCorpus: ['Username', 'Password'], snapshot: '- textbox "Username"\n- textbox "Password"\n- button "Login"' });
const form = formRes.capabilities.find((c) => c.type === 'form');
assert(form && form.operations.includes('fillField') && form.operations.includes('submitForm'), 'login form (2 inputs + submit) → form capability with fillField + submitForm');
assert(form && form.evidence.fields.length === 2, 'form evidence captures both input fields');

// A product table — the marquee entity_collection ("pick the least price").
const productTable = [
  el('columnheader', 'Name', [durable('getByRole("columnheader", { name: "Name" })')]),
  el('columnheader', 'Price', [durable('getByRole("columnheader", { name: "Price" })')]),
  el('row', 'iPhone 17 black 999', [durable('getByRole("row", { name: "iPhone 17 black 999" })', 0.7)]),
  el('row', 'iPhone 17 white 1099', [durable('getByRole("row", { name: "iPhone 17 white 1099" })', 0.7)]),
];
const tableRes = caps.classifyCapabilities({ elements: productTable, textCorpus: ['Name', 'Price'], snapshot: '- table:\n  - columnheader "Name"\n  - columnheader "Price"\n  - row "iPhone 17 black 999"' });
const coll = tableRes.capabilities.find((c) => c.type === 'entity_collection');
assert(coll && ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'].every((o) => coll.operations.includes(o)),
  'product table → entity_collection with select / rank / choose / assertTableContains');
assert(coll && Array.isArray(coll.evidence.columns) && coll.evidence.columns.some((c) => c && c.name === 'Name') && coll.evidence.columns.some((c) => c && c.name === 'Price'),
  'entity_collection columns carry {name} (Name, Price) lifted from the structure');
assert(coll && coll.evidence.columns.every((c) => c && typeof c === 'object' && 'selector' in c), 'P3d — columns are {name, selector} (per-column durable evidence for execution), not bare labels');
assert(coll && coll.evidence.rowSelector && /getByRole\("row"/.test(coll.evidence.rowSelector.selector || ''), 'entity_collection rowSelector is a durable getByRole("row", …) — replayable cross-session');
assert(coll && typeof coll.capabilityId === 'string' && /^cap-[0-9a-f]{10}$/.test(coll.capabilityId), 'P3d — every capability gets a deterministic capabilityId (cap-<sha1[:10]>)');

// A workflow action that is NOT the form submit.
const adminButtons = [
  el('button', 'Add', [durable('getByRole("button", { name: "Add" })')]),
  el('button', 'Delete', [durable('getByRole("button", { name: "Delete" })')]),
];
const actRes = caps.classifyCapabilities({ elements: adminButtons, textCorpus: [], snapshot: '- button "Add"\n- button "Delete"' });
const action = actRes.capabilities.find((c) => c.type === 'workflow_action');
assert(action && action.operations.includes('invokeAction') && /Delete/.test(action.name), 'a Delete button (action verb) → workflow_action / invokeAction');

// Vocabulary coherence: EVERY capability the classifier emits validates against
// the frozen vocabulary, and every op is legal for its type. This is the
// atlas→vocabulary seam contract — the classifier can never emit a record the
// BDD lane (which imports the same vocabulary) would reject.
const allEmitted = [...formRes.capabilities, ...tableRes.capabilities, ...actRes.capabilities];
assert(allEmitted.length >= 3, 'classifier emitted capabilities across the synthetic pages');
assert(allEmitted.every((c) => vocab.validateCapabilityRecord(c).ok), 'EVERY emitted capability validates against the frozen vocabulary (atlas→vocab coherence)');
assert(allEmitted.every((c) => c.operations.every((o) => vocab.operationsForType(c.type).includes(o))), 'EVERY emitted operation is legal for its capability type');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Selector discipline — durable + cross-session only (ephemeral ref dropped)');
const refOnlyBtn = { semanticLabel: 'button "Ghost"', ariaRole: 'button', parentContext: '', selectorChain: [{ selector: 'ref=e9', strategy: 'mcp-ref', verified: true, stabilityScore: 0.3 }] };
assert(caps.bestSelector(refOnlyBtn) === null, 'a control whose ONLY locator is an ephemeral mcp-ref → bestSelector null (cannot anchor a capability)');
assert(caps.bestSelector(loginForm[2]) === 'getByRole("button", { name: "Login" })', 'a durable selector is chosen over the appended ephemeral ref (snapshot-derived, even when verified:false)');
const ghostRes = caps.classifyCapabilities({ elements: [refOnlyBtn], textCorpus: [], snapshot: '- button "Ghost"' });
assert(ghostRes.capabilities.length === 0, 'a page whose only control is ref-only yields ZERO capabilities (unusable ⇒ dropped)');
assert(allEmitted.every((c) => !/(^|")ref=e\d/.test(JSON.stringify(c.evidence))), 'no emitted capability evidence carries a bare ref=eN selector');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Calibrator wiring — classify per page + graceful capabilitiesJson persist');
const cal = read('server', 'services', 'agents', 'calibrator.js');
assert(/require\('\.\/atlasCapabilities'\)/.test(cal), 'calibrator imports ./atlasCapabilities');
assert(/classifyCapabilities\(\{\s*elements:\s*classifierElements/.test(cal), 'calibrator calls classifyCapabilities with the wider classifierElements set');
assert(/extractElements\(snap,\s*CLASSIFIER_ROLES\)/.test(cal), 'classifier input uses CLASSIFIER_ROLES (rows / columnheaders / dialogs) — entity_collection can fire');
assert(/\belements = extractElements\(snap\)/.test(cal) && /elementsJson: JSON\.stringify\(elements\)/.test(cal),
  'elementsJson stays interactive-only (extractElements(snap) default filter persisted) — conductor/atlas unchanged');
assert(/capabilitiesJson:\s*JSON\.stringify\(capabilities\)/.test(cal), 'rich create persists capabilitiesJson');
assert(/catch\s*\(capPersistErr\)[\s\S]{0,700}?calibrationPage\.create\(\{\s*data:\s*baseData\s*\}\)/.test(cal),
  'pre-regen fallback: on the unknown-column error the base write (no capabilitiesJson) keeps the crawl alive');
assert(/capabilitiesCount:\s*capabilities\.length/.test(cal), 'WS calibration.page.complete carries capabilitiesCount');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Atlas is HOW-only — anti-circular firewall (P3 ↔ P2)');
assert(tcc.APP_ORIGIN_PROVENANCE.has('atlas'), "'atlas' is an app-origin provenance (the site can never be the source of a business truth)");
const circ = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'atlas' }] });
assert(!circ.ok && circ.violations.includes('must_provenance_app_origin'), 'a must whose expected value originates from the atlas → must_provenance_app_origin (atlas governs HOW, never WHAT)');
const docMust = tcc.assertContractComplete({ automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'doc_quoted' }] });
assert(docMust.ok, 'a must traced to a requirement (doc_quoted) is still fine — only app/atlas-origin musts are blocked');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[6] Schema + migration — P3 slice substrate (additive)');
const schema = read('prisma', 'schema.prisma');
for (const f of ['module', 'authProfileId', 'version', 'isCurrent', 'atlasFingerprint', 'staleAt']) {
  assert(new RegExp(`\\b${f}\\b`).test(schema), `Calibration carries the slice field ${f}`);
}
assert(/@@index\(\[projectId, module, authProfileId, isCurrent\]\)/.test(schema), 'Calibration is indexed by its slice key (projectId, module, authProfileId, isCurrent)');
assert(/capabilitiesJson\s+String\?/.test(schema), 'CalibrationPage.capabilitiesJson column added');
const migDir = path.join(__dirname, '..', 'prisma', 'migrations', '20260610000000_add_p3_atlas_slices');
const migSql = fs.existsSync(path.join(migDir, 'migration.sql')) ? fs.readFileSync(path.join(migDir, 'migration.sql'), 'utf8') : '';
assert(/ADD COLUMN "capabilitiesJson"/.test(migSql) && /ADD COLUMN "atlasFingerprint"/.test(migSql) && /ADD COLUMN "version"/.test(migSql),
  'migration is additive ADD COLUMN for the slice fields + capabilitiesJson');
assert(/CREATE INDEX "Calibration_projectId_module_authProfileId_isCurrent_idx"/.test(migSql), 'migration creates the slice index');

// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────
console.log('\n[7] atlasSlice — slice math: fingerprint / drift / freshness (P3b, pure)');

// computeAtlasFingerprint — order-independent, content-addressed.
const fpA = slice.computeAtlasFingerprint(['h1', 'h2', 'h3']);
const fpB = slice.computeAtlasFingerprint(['h3', 'h1', 'h2']);   // same set, different order
const fpC = slice.computeAtlasFingerprint(['h1', 'h2', 'h9']);   // one page changed
assert(fpA && fpA === fpB, 'atlas fingerprint is order-independent (crawl order does not matter)');
assert(fpA !== fpC, 'any page structure changing → a different fingerprint (drift is detectable)');
assert(fpA.startsWith(slice.ATLAS_SCHEMA_VERSION + '-'), 'atlas fingerprint carries the parser schema version');
assert(slice.computeAtlasFingerprint([]) === null, 'no pages → no fingerprint (null)');

// decideSliceVersion — THE drift → version++ rule.
assert(slice.decideSliceVersion({ priorVersion: 0 }).drift === 'new' && slice.decideSliceVersion({ priorVersion: 0 }).version === 1, 'no prior slice → v1, drift "new"');
const same = slice.decideSliceVersion({ priorVersion: 2, priorFingerprint: fpA, newFingerprint: fpA });
assert(same.version === 2 && same.drift === 'unchanged' && same.supersede, 'identical fingerprint → same version, "unchanged" (a refresh — new row still becomes current)');
const drifted = slice.decideSliceVersion({ priorVersion: 2, priorFingerprint: fpA, newFingerprint: fpC });
assert(drifted.version === 3 && drifted.drift === 'changed' && drifted.supersede, 'changed fingerprint → version++ + supersede prior current (drift gate)');

// atlasFreshness — stale surfaced, not hidden.
const DAY = 86400000;
assert(slice.atlasFreshness(new Date(Date.now() - DAY)).stale === false, 'a 1-day-old atlas is fresh');
assert(slice.atlasFreshness(new Date(Date.now() - 30 * DAY)).stale === true, 'a 30-day-old atlas is stale (past the 14-day horizon)');
assert(slice.atlasFreshness(new Date(Date.now() - DAY), Date.now(), null, 'atlas-oldfingerprint').schemaStale === true, 'old parser-schema atlas is flagged stale');
assert(slice.atlasFreshness(null).stale === false, 'no completedAt → not stale (nothing to judge)');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[8] pickSlice — slice selection + the WRONG-ROLE firewall (P3b)');
const sExactCur = { id: 'a', module: 'pim', authProfileId: 'demo', version: 2, isCurrent: true, completedAt: new Date(Date.now() - DAY) };
const sExactOld = { id: 'b', module: 'pim', authProfileId: 'demo', version: 1, isCurrent: false, completedAt: new Date(Date.now() - 5 * DAY) };
const sAdmin = { id: 'c', module: 'pim', authProfileId: 'admin', version: 1, isCurrent: true, completedAt: new Date(Date.now() - DAY) };
const sLegacy = { id: 'd', module: null, authProfileId: null, version: 1, isCurrent: true, completedAt: new Date(Date.now() - 2 * DAY) };

let pk = slice.pickSlice([sExactOld, sExactCur, sAdmin, sLegacy], { module: 'pim', authProfileId: 'demo' });
assert(pk.chosen && pk.chosen.id === 'a' && !pk.degraded, 'exact (module+authProfile) CURRENT slice is chosen — and the current v2 beats the historical v1');

pk = slice.pickSlice([sAdmin, sLegacy], { module: 'pim', authProfileId: 'demo' });
assert(pk.chosen && pk.chosen.id === 'd' && pk.degraded === 'no_authprofile_slice', 'no demo slice → falls back to the role-agnostic (null) slice, flagged degraded');

pk = slice.pickSlice([sAdmin], { module: 'pim', authProfileId: 'demo' });
assert(pk.chosen === null && pk.degraded === 'no_slice', "WRONG-ROLE FIREWALL: a demo run is NEVER given the admin slice (admin ≠ demo evidence) — returns nothing");

pk = slice.pickSlice([sExactCur, sLegacy], {});
assert(pk.chosen && pk.chosen.isCurrent, 'no slice requested (legacy caller) → a current-complete slice is returned (back-compatible)');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[9] Calibrator wiring — slice population + drift + slice-aware reads (P3b)');
assert(/require\('\.\.\/\.\.\/lib\/atlasSlice'\)/.test(cal), 'calibrator imports atlasSlice');
assert(/computeAtlasFingerprint\(pageHashes\)/.test(cal), 'completion computes the atlas fingerprint from the crawled pages');
assert(/decideSliceVersion\(/.test(cal) && /isCurrent:\s*true/.test(cal), 'completion sets version via decideSliceVersion + marks the new slice current');
assert(/updateMany\([\s\S]{0,260}?isCurrent:\s*false/.test(cal), 'drift supersedes the prior current slice (updateMany isCurrent:false)');
assert(/function loadCurrentCalibration\(projectId, opts/.test(cal) && /atlasSlice\.pickSlice\(/.test(cal), 'reads resolve through loadCurrentCalibration → pickSlice (wrong-role firewall on the read path)');
assert(/getCalibrationAtlas\(projectId, opts = \{\}\)/.test(cal) && /stale:\s*!!\(freshness/.test(cal), 'getCalibrationAtlas is slice-aware (opts) and surfaces stale/degraded/slice');
assert(/capabilities\.push\(\{ capabilityId: c\.capabilityId/.test(cal), 'getCalibrationAtlas projects the FULL capability (capabilityId + evidence) into the menu — binding by id + BDD field-grounding (P3d live-smoke regression guard)');
assert(/findFirst\(\{[\s\S]{0,200}?status: 'complete'[\s\S]{0,160}?orderBy: \{ createdAt: 'desc' \}/.test(cal), 'a pre-regen client falls back to the legacy newest-complete query (running backend keeps grounding)');
const calRoute = read('server', 'routes', 'calibration.js');
assert(/module,\s*authProfileId\s*\}\s*=\s*req\.body/.test(calRoute) && /authProfileId:\s*sliceAuthProfileId/.test(calRoute), 'calibrate route accepts module + authProfileId and threads them into runCalibrator (graceful create)');
assert(/req\.query\.module/.test(calRoute) && /req\.query\.authProfileId/.test(calRoute), 'calibration list supports module/authProfileId filters');
assert(/module:\s*true/.test(calRoute) && /authProfileId:\s*true/.test(calRoute) && /version:\s*true/.test(calRoute) && /isCurrent:\s*true/.test(calRoute), 'calibration list returns slice metadata for the UI');
const projectSetup = read('src', 'pages', 'ProjectSetup.jsx');
assert(/\/modules\/preview/.test(projectSetup) && /\/auth-profiles/.test(projectSetup), 'ProjectSetup CalibratorPanel loads detected modules + auth profiles');
assert(/body\.module\s*=\s*selectedModuleKey/.test(projectSetup) && /body\.authProfileId\s*=\s*selectedAuthProfileId/.test(projectSetup), 'ProjectSetup CalibratorPanel POSTs module/authProfileId into calibration start');
assert(/Module scope/.test(projectSetup) && /Auth profile/.test(projectSetup), 'ProjectSetup renders module/auth selectors for site calibration');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[10] RequirementSiteMismatch reconciliation (P3c, findings-only)');
const reconcile = require('../server/services/requirementSiteReconcile');

const reqExport = { id: 'REQ-exp', behaviourText: 'User can export the employee list to PDF' };
const reqApprove = { id: 'REQ-app', behaviourText: 'Manager can approve the leave request' };
const reqFill = { id: 'REQ-fill', behaviourText: 'User fills the username and password' };

assert(reconcile.inferRequiredCapabilities(reqExport.behaviourText).some((n) => n.accepts.includes('file')), '"export … to PDF" → implies a file capability');
assert(reconcile.inferRequiredCapabilities(reqApprove.behaviourText).some((n) => n.accepts.includes('workflow_action')), '"approve …" → implies a workflow_action capability');
assert(reconcile.inferRequiredCapabilities(reqFill.behaviourText).length === 0, '"fills the username" → infers nothing (form is omitted: present in every app, zero signal)');

const invFormColl = reconcile.buildCapabilityInventory([{ type: 'form' }, { type: 'entity_collection' }]);
assert(invFormColl.types.has('form') && invFormColl.types.has('entity_collection') && invFormColl.count === 2, 'buildCapabilityInventory collects the present capability TYPES');

// THE GUARD: no mapped capabilities → ZERO findings (absence of crawl evidence
// is NOT evidence the site lacks the feature).
assert(reconcile.reconcileRequirementsToSite([reqExport], reconcile.buildCapabilityInventory([])).length === 0, 'EMPTY inventory → NO findings (the critical guard — we never claim a feature is missing we never crawled)');
assert(reconcile.reconcileRequirementsToSite([reqExport], null).length === 0, 'null inventory → NO findings (inert until a calibration maps capabilities)');

// Populated inventory WITHOUT the implied capability → a finding.
const fExport = reconcile.reconcileRequirementsToSite([reqExport], invFormColl);
assert(fExport.length === 1 && fExport[0].kind === 'requirement_site_mismatch' && fExport[0].severity === 'warning' && fExport[0].requirementId === 'REQ-exp',
  'export requirement + atlas with no file capability → one requirement_site_mismatch (warning, HOLD-class)');
assert(/not weakened/i.test(fExport[0].detail), 'the finding states the requirement is NOT weakened (atlas never overrides business truth)');

// Inventory WITH the implied capability → no finding.
const invWithFile = reconcile.buildCapabilityInventory([{ type: 'form' }, { type: 'file' }]);
assert(reconcile.reconcileRequirementsToSite([reqExport], invWithFile).length === 0, 'export requirement + atlas that HAS a file capability → no finding (site supports it)');
assert(reconcile.reconcileRequirementsToSite([reqApprove], invFormColl).length === 1, 'approve requirement + atlas with no workflow_action/modal → one finding');

// Wiring.
const scn = read('server', 'routes', 'scenarios.js');
assert(/persistSiteMismatchFindings\(/.test(scn) && /calibrationAtlas\.capabilities/.test(scn), 'scenarios.js /generate runs site reconciliation, guarded by a non-empty atlas capability inventory');
assert(/capabilities,/.test(cal) && /JSON\.parse\(p\.capabilitiesJson/.test(cal), 'getCalibrationAtlas surfaces the per-page capabilities (the inventory the reconciler reads)');

// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────
console.log('\n[11] capabilityId — deterministic + slice-scoped (P3d)');
const idA = caps.computeCapabilityId({ module: 'pim', authProfileId: 'admin', pageUrl: '/admin/users', type: 'workflow_action', name: 'Delete', primarySelector: 'getByRole("button",{name:"Delete"})' });
const idA2 = caps.computeCapabilityId({ module: 'pim', authProfileId: 'admin', pageUrl: '/admin/users', type: 'workflow_action', name: 'Delete', primarySelector: 'getByRole("button",{name:"Delete"})' });
const idB = caps.computeCapabilityId({ module: 'pim', authProfileId: 'admin', pageUrl: '/pim/employees', type: 'workflow_action', name: 'Delete', primarySelector: 'getByRole("button",{name:"Delete"})' });
const idC = caps.computeCapabilityId({ module: 'leave', authProfileId: 'admin', pageUrl: '/admin/users', type: 'workflow_action', name: 'Delete', primarySelector: 'getByRole("button",{name:"Delete"})' });
assert(/^cap-[0-9a-f]{10}$/.test(idA) && idA === idA2, 'capabilityId is deterministic (same module+page+type+name+selector → same id)');
assert(idA !== idB, 'a "Delete" on a DIFFERENT page → different id (no cross-page collision)');
assert(idA !== idC, 'a "Delete" in a DIFFERENT module → different id (slice-scoped identity)');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[12] operationPlan — Node disposes the operations[] plan (P3d)');
const opInv = [
  { capabilityId: 'cap-prod', type: 'entity_collection', name: 'Products', operations: ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'], evidence: { columns: [{ name: 'price', selector: 'x' }], rowSelector: { selector: 'y' } } },
  { capabilityId: 'cap-act', type: 'workflow_action', name: 'Place Order', operations: ['invokeAction'], evidence: { action: { selector: 'z' } } },
];
// All-valid plan → kept, nothing dropped.
let res = opPlan.validateCaseOperations([
  { operation: 'selectEntityWhere', capabilityRef: 'cap-prod', params: { entity: 'product', criteria: [{ field: 'price', operator: 'lt', value: 1000 }] } },
  { operation: 'rankByMin', capabilityRef: 'cap-prod', params: { field: 'price' } },
  { operation: 'invokeAction', capabilityRef: 'cap-act', params: { action: 'Place Order' } },
], { capabilities: opInv });
assert(res.operations.length === 3 && res.dropped.length === 0, 'a fully-bound plan (ops valid for their capabilities) → all kept, none dropped');

const dropReason = (ops, inv = opInv) => { const r = opPlan.validateCaseOperations(ops, { capabilities: inv }); return r.dropped[0] && r.dropped[0].reason; };
assert(dropReason([{ operation: 'teleport', capabilityRef: 'cap-prod' }]) === 'operation_not_in_vocabulary', 'invented operation → dropped (not in capabilityVocabulary)');
assert(dropReason([{ operation: 'invokeAction', params: { action: 'x' } }]) === 'operation_missing_capability_ref', 'non-global op with no capabilityRef → dropped');
assert(dropReason([{ operation: 'invokeAction', capabilityRef: 'cap-ghost' }]) === 'capability_not_in_atlas', 'foreign capabilityRef → dropped (RequirementSiteMismatch-class)');
assert(dropReason([{ operation: 'invokeAction', capabilityRef: 'cap-prod' }]) === 'operation_not_allowed_for_type', 'op not valid for the resolved capability type → dropped');
assert(dropReason([{ operation: 'selectEntityWhere', capabilityRef: 'cap-prod', params: { criteria: [{ field: 'price', operator: 'approximately', value: 1 }] } }]) === 'bad_criteria_operator', 'criteria operator outside CRITERIA_OPERATORS → dropped');
assert(opPlan.validateCaseOperations([{ operation: 'assertVisibleText', params: { text: 'Welcome' } }], { capabilities: opInv }).operations.length === 1, 'a GLOBAL op (assertVisibleText) needs NO capabilityRef → kept');

// markCaseOperations stamps the per-case export-gate signal.
const scen = [{ cases: [
  { name: 'good', operations: [{ operation: 'rankByMin', capabilityRef: 'cap-prod', params: { field: 'price' } }] },
  { name: 'mixed', operations: [{ operation: 'rankByMin', capabilityRef: 'cap-prod', params: { field: 'price' } }, { operation: 'teleport', capabilityRef: 'cap-prod' }] },
] }];
const ms = opPlan.markCaseOperations(scen, opInv);
assert(scen[0].cases[0].operationStatus === 'complete' && (scen[0].cases[0].operationsDropped || []).length === 0, 'a case with only valid ops → operationStatus "complete"');
assert(scen[0].cases[1].operationStatus === 'incomplete' && scen[0].cases[1].operationsDropped.length === 1, 'a case with a dropped op → operationStatus "incomplete" + dropped recorded (THE export-gate signal)');
assert(ms.incompleteCases === 1 && ms.totalDropped === 1, 'markCaseOperations tallies incomplete cases + drops for the run');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[13] P3d wiring — emit + dispose + persist + module-scope (static prompt unchanged)');
const arch = read('server', 'services', 'agents', 'architect.js');
assert(/require\('\.\/operationPlan'\)/.test(arch) && /operationPlan\.markCaseOperations\(parsed/.test(arch), 'architect imports operationPlan + disposes operations[] on the parsed JSON (Node disposes)');
assert(/function buildCapabilityMenu\(/.test(arch) && /capabilityMenuBlock/.test(arch), 'architect builds the capability menu as a DYNAMIC block (static SYSTEM_PROMPT untouched)');
assert(/operations,\s*operationStatus,\s*operationsDropped/.test(arch), 'normaliseCase passes operations + operationStatus + operationsDropped through to persistCases');
const tccSrc = read('server', 'services', 'testCaseContract.js');
assert(/requirementRefs: reqRefs, operationsJson/.test(tccSrc) && /data: \{ \.\.\.data, requirementRefs: reqRefs \}/.test(tccSrc), 'persistCases uses the 3-level ladder {refs+ops}→{refs}→{base} (operationsJson never knocks out requirementRefs on the current client)');
assert(/status: c\.operationStatus \|\| 'complete',\s*operations:/.test(tccSrc), 'operationsJson persists { status, operations, dropped } (export gate reads status/dropped; bridge reads operations)');
assert(/rankClauses\(\s*\n?\s*clausePrep\.requirementClauses, clauseScope/.test(scn) && /maxClauses: 40/.test(scn), 'scenarios.js scopes clauses (rankClauses to module/focus, capped) — the max_tokens fix');
// Step 2 — the capability menu + typed operations[] are now fed for WHOLE-PROJECT
// generation too (not only module-scoped). The atlas inventory is passed whenever
// an atlas exists; `module` is still threaded (null on whole-project).
assert(/capabilities: calibrationAtlas \? \(calibrationAtlas\.capabilities \|\| \[\]\) : \[\]/.test(scn) && /module: moduleScope,/.test(scn), 'scenarios.js feeds the capability menu for whole-project AND module-scoped generation (Step 2)');
const schemaP3d = read('prisma', 'schema.prisma');
assert(/operationsJson\s+String\?/.test(schemaP3d), 'TestCase.operationsJson column added');
const migOps = path.join(__dirname, '..', 'prisma', 'migrations', '20260611000000_add_operations_json', 'migration.sql');
assert(fs.existsSync(migOps) && /ADD COLUMN "operationsJson"/.test(fs.readFileSync(migOps, 'utf8')), 'additive migration adds operationsJson');

console.log(`\n${failures === 0 ? 'PASS — P3a HOW-oracle + P3b slices/drift/wrong-role + P3c reconciliation + P3d operations[] emit/dispose/persist (whole-project + module-scoped) enforced' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
