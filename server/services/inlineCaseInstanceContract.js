'use strict';

const { sha256 } = require('./testDesignPlanV1');

const VERSION = 1;

function cleanRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * One precedence contract for every text-entry surface. The caller may identify
 * the surface for evidence, but it never changes precedence: an explicit inline
 * data block wins over pasted/uploaded text values, which win over later prose.
 */
function resolveInlineValueSources({
  inlineDataValues = {},
  pastedTextValues = {},
  uploadedTextValues = {},
  narrativeValues = {},
  surface = null,
} = {}) {
  const sources = [
    ['narrative_text', cleanRecord(narrativeValues)],
    ['uploaded_text', cleanRecord(uploadedTextValues)],
    ['pasted_text', cleanRecord(pastedTextValues)],
    ['inline_data_block', cleanRecord(inlineDataValues)],
  ];
  const values = {};
  const provenance = {};
  for (const [source, entries] of sources) {
    for (const [key, value] of Object.entries(entries)) {
      if (!String(key || '').trim() || value == null) continue;
      values[key] = value;
      provenance[key] = source;
    }
  }
  return { values, provenance, surface: surface || null, precedenceVersion: VERSION };
}

function caseScopeId(value = {}) {
  return String(value.caseScopeId || value.planCaseId || value.testCaseId || value.caseId || value.id || '').trim() || null;
}

function instancePlanId({ planCaseId, inlineRevision, rowId } = {}) {
  return `tdri_${sha256({
    version: VERSION,
    planCaseId,
    inlineRevision,
    rowId,
  }).slice(0, 24)}`;
}

function instanceRevision({
  instancePlanId: suppliedInstancePlanId,
  planCaseId,
  inlineRevision,
  rowId,
  ordinal,
  executableProjection,
} = {}) {
  const resolvedInstancePlanId = suppliedInstancePlanId || instancePlanId({
    planCaseId,
    inlineRevision,
    rowId,
  });
  return sha256({
    version: VERSION,
    instancePlanId: resolvedInstancePlanId,
    planCaseId,
    inlineRevision,
    rowId,
    ordinal,
    executableProjection,
  });
}

module.exports = {
  VERSION,
  instancePlanId,
  instanceRevision,
  resolveInlineValueSources,
  caseScopeId,
};
