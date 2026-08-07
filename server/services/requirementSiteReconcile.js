'use strict';

/**
 * Enterprise Mode P3c — RequirementSiteMismatch reconciliation.
 *
 * The atlas (P3a/P3b) proves HOW the site behaves; the requirement oracle (P2)
 * proves WHAT the business asked for. This module reconciles the two in ONE
 * direction only: when a requirement's behaviour clearly implies a capability
 * TYPE that is ABSENT from the calibrated atlas for the module, surface a
 * `requirement_site_mismatch` finding. It is the complement of the anti-circular
 * firewall (a `must` may never originate from the atlas — testCaseContract):
 * here the requirement still rules, and the SITE is questioned, never the other
 * way round. The atlas never weakens a requirement; it can only raise a doubt.
 *
 * DOCTRINE:
 *  - Findings-only / non-blocking until P9 (warning severity, HOLD-class).
 *  - Deterministic (keyword → capability inference + set membership) — Node, not
 *    LLM (per CLAUDE.md "Node unless genuine novelty"); the verb sets mirror the
 *    classifier's own ACTION_RE / FILE_RE so inference and detection agree.
 *  - CRITICAL GUARD: an EMPTY/absent capability inventory yields ZERO findings.
 *    Absence of crawl evidence is NOT evidence the site lacks the feature (the
 *    crawl is bounded; the page may simply not have been visited). We only ever
 *    say "no atlas evidence for X — verify coverage", never "the site can't X".
 *
 * Pure functions (inferRequiredCapabilities, buildCapabilityInventory,
 * reconcileRequirementsToSite) take no DB/LLM and are guarded by
 * scripts/verify_atlas.cjs. persistSiteMismatchFindings is the thin DB writer.
 */

const vocab = require('../lib/capabilityVocabulary');

/**
 * Capability inference rules. Each rule matches requirement behaviour text and
 * declares the capability types that would SATISFY it (`accepts`). A finding
 * fires only when NONE of `accepts` is present in the atlas inventory — the
 * broad accept-sets (e.g. any collection-ish type) keep precision high. Kept
 * deliberately CONSERVATIVE: only strong, unambiguous verbs infer a requirement
 * on a site capability. Common verbs (fill/submit/login) are omitted — a form is
 * present in virtually every app, so their absence is never a useful signal.
 */
const CAP_INFERENCE = [
  {
    label: 'file (export / download)',
    accepts: ['file'],
    re: /\b(export|download|generate (?:a |the )?(?:pdf|csv|excel|report|file|statement|invoice))\b/i,
  },
  {
    label: 'workflow_action (approve / delete / publish …)',
    accepts: ['workflow_action', 'modal'],
    re: /\b(approve|reject|delete|remove|cancel|publish|archive|deactivate|activate|withdraw|assign|terminate)\b/i,
  },
  {
    label: 'collection (list / table / search / sort)',
    accepts: ['entity_collection', 'table', 'list', 'search_filter_sort', 'menu'],
    re: /\b(sort|filter|search (?:for|the)|rank|select (?:the |a )?(?:row|record|item|entry|employee|product)|from the (?:list|table|grid))\b/i,
  },
];

/**
 * Which capability types a requirement's behaviour text implies.
 * @param {string} text
 * @returns {Array<{label:string, accepts:string[]}>}
 */
function inferRequiredCapabilities(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  return CAP_INFERENCE.filter((rule) => rule.re.test(t)).map((r) => ({ label: r.label, accepts: r.accepts.slice() }));
}

/**
 * Build the atlas capability inventory from getCalibrationAtlas().capabilities
 * (a flat [{ type, name, operations }]). Returns the present TYPES + a count.
 * @param {Array} capabilities
 * @returns {{ types: Set<string>, count: number }}
 */
function buildCapabilityInventory(capabilities) {
  const types = new Set();
  const list = Array.isArray(capabilities) ? capabilities : [];
  for (const c of list) {
    if (c && typeof c.type === 'string' && vocab.isCapabilityType(c.type)) types.add(c.type);
  }
  return { types, count: list.length };
}

/**
 * Reconcile requirements against the atlas capability inventory.
 *
 * @param {Array<{id,behaviourText}>} requirements
 * @param {{types:Set<string>, count:number}} inventory
 * @param {object} [opts]  { pagesCrawled?:number }
 * @returns {Array<{requirementId, kind, severity, summary, detail, impliedCapability}>}
 */
function reconcileRequirementsToSite(requirements, inventory, opts = {}) {
  const findings = [];
  // THE GUARD: no mapped capabilities → we cannot claim the site lacks anything.
  if (!inventory || !(inventory.types instanceof Set) || inventory.count === 0 || inventory.types.size === 0) {
    return findings;
  }
  const pagesNote = opts.pagesCrawled ? ` (atlas crawled ${opts.pagesCrawled} page(s))` : '';
  for (const r of requirements || []) {
    if (!r || !r.id) continue;
    const implied = inferRequiredCapabilities(r.behaviourText);
    for (const need of implied) {
      const satisfied = need.accepts.some((tp) => inventory.types.has(tp));
      if (satisfied) continue;
      findings.push({
        requirementId: r.id,
        kind: 'requirement_site_mismatch',
        severity: 'warning',
        impliedCapability: need.label,
        summary: `Requirement ${r.id}: no atlas evidence for ${need.label}`,
        detail: `${r.id} implies a "${need.label}" capability, but none was found in the calibrated atlas for this module${pagesNote}. `
          + `Either the feature is missing, or the page that exposes it was not crawled — verify coverage. `
          + (r.behaviourText ? `Behaviour: "${String(r.behaviourText).slice(0, 240)}". ` : '')
          + `This is a findings-only signal; the requirement is NOT weakened and the atlas never overrides business truth.`,
      });
    }
  }
  return findings;
}

/**
 * Persist site-mismatch findings as Discrepancy rows (kind
 * 'requirement_site_mismatch'). Mirrors requirementOracle.persistRtmFindings:
 * findings-only, graceful (a write failure stops the loop, never crashes the
 * generation). Returns counts. NEVER throws.
 *
 * @param {{prisma, projectId, requirements, atlasCapabilities, pagesCrawled?, log?}} args
 */
async function persistSiteMismatchFindings({ prisma, projectId, requirements, atlasCapabilities, pagesCrawled = 0, log = console }) {
  const inventory = buildCapabilityInventory(atlasCapabilities);
  const findings = reconcileRequirementsToSite(requirements, inventory, { pagesCrawled });
  let written = 0;
  for (const f of findings) {
    try {
      await prisma.discrepancy.create({
        data: {
          projectId,
          kind: f.kind,
          severity: f.severity || 'warning',
          summary: String(f.summary || 'Requirement/site mismatch').slice(0, 300),
          detail: String(f.detail || f.summary || '').slice(0, 4000) || f.kind,
        },
      });
      written++;
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[site-reconcile] discrepancy write degraded (stopping): ${e.message}`);
      break;
    }
  }
  return { findingsCount: findings.length, written, inventoryTypes: [...inventory.types] };
}

module.exports = {
  CAP_INFERENCE,
  inferRequiredCapabilities,
  buildCapabilityInventory,
  reconcileRequirementsToSite,
  persistSiteMismatchFindings,
};
