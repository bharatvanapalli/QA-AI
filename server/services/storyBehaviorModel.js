'use strict';

/**
 * STORY BEHAVIOR MODEL — the ADO/Jira text lane (Phase A).
 *
 * Most real test input is rich TEXT work items (ADO/Jira stories), not clean
 * spreadsheets. The pipeline is:
 *
 *   ADO text  --(LLM extractor: storyBehaviorExtractor)-->  behavior model
 *   behavior model  --(THIS module, deterministic)-->  scenarios + synthetic
 *                                                       data rows + requiredEvidence
 *
 * Per CLAUDE.md ("Node unless genuine novelty"): EXTRACTING constraints from
 * prose is genuine reasoning (LLM). GENERATING boundary rows + evidence from a
 * structured constraint set is deterministic — so it lives here, in Node, and is
 * unit-testable WITHOUT a browser or an LLM.
 *
 * Behavior model shape (populated by the extractor; validated here):
 *   {
 *     actor, feature,
 *     preconditions: [string],
 *     actions: [string],                      // add note, edit note, delete note
 *     fields: [{
 *       name, role,                           // role: 'noteText' | 'email' | 'select' | ...
 *       optional?: boolean,
 *       maxLength?: number, minLength?: number,
 *       counterRequired?: boolean,            // a live character counter is shown
 *       format?: 'email' | string,            // a named value format
 *       example?: string,
 *     }],
 *     businessRules: [{
 *       kind: 'max_count' | 'confirmation_required' | 'ordering' | 'edit_moves_to_top' | 'disabled_when_full',
 *       entity?, max?, action?, message?, order?, control?,
 *     }],
 *   }
 *
 * Output scenario spec (one per behavior class), shaped so it flows through the
 * SAME execution + verdict path as a data-matrix row:
 *   { name, intentClass, inputs, requiredEvidence[], advisoryExpectations[], provenance:'qa_standard'|'doc_quoted' }
 *
 * requiredEvidence vocabulary used here (checkers land in Phase B; until then the
 * Conductor reports them unobservable -> not_judged, never a fake pass):
 *   field_accepts_value{field,length} · value_rejected{field,reason} ·
 *   counter_shows{field,expected} · element_present{label} · element_absent{label} ·
 *   item_count{entity,expected} · control_disabled{control} · control_enabled{control} ·
 *   message_visible{textHint} · confirmation_visible{textHint} · choice_outcome{choice,result} ·
 *   page_present{page} · format_rejected{field,format}
 */

const MAX_GENERATED_SCENARIOS = 40; // bound the fan-out from one story

function isPosInt(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; }

// Deterministic value synthesis — NO Math.random (reproducible runs).
function repeatChar(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }

function sampleValue(field, variant) {
  const role = String((field && field.role) || '').toLowerCase();
  const fmt = String((field && field.format) || '').toLowerCase();
  const max = isPosInt(field && field.maxLength) ? field.maxLength : null;
  if (variant === 'blank') return '';
  if (variant === 'maxLen' && max) return repeatChar('a', max);
  if (variant === 'overMax' && max) return repeatChar('a', max + 1);
  if (variant === 'invalidFormat') {
    if (fmt === 'email') return 'invalid-email-no-at-sign';
    return '!!!';
  }
  // typical / validFormat
  if (fmt === 'email' || role === 'email') return (field && field.example) || 'qaai.user@example.com';
  if (field && field.example) return String(field.example);
  return 'Sample value 1';
}

function scn(name, intentClass, inputs, requiredEvidence, advisory, provenance) {
  return {
    name,
    intentClass,
    inputs: inputs || {},
    requiredEvidence: requiredEvidence || [],
    advisoryExpectations: advisory || [],
    provenance: provenance || 'doc_quoted',
  };
}

function generateScenariosFromBehaviorModel(model) {
  const out = [];
  if (!model || typeof model !== 'object') return out;
  const fields = Array.isArray(model.fields) ? model.fields : [];
  const rules = Array.isArray(model.businessRules) ? model.businessRules : [];
  const featureLabel = String(model.feature || 'feature');

  // ── Per-field, constraint-derived scenarios ───────────────────────────
  for (const f of fields) {
    if (!f || !f.name) continue;
    const fname = String(f.name);

    // Optional field can be saved blank (a senior-QA standard check the doc rarely lists).
    if (f.optional === true) {
      out.push(scn(`${fname}: optional left blank is accepted`, 'success',
        { [fname]: '' },
        [{ kind: 'field_accepts_value', field: fname, length: 0 }, { kind: 'page_present', page: 'saved' }],
        [], 'qa_standard'));
    }

    // Max-length acceptance + counter.
    if (isPosInt(f.maxLength)) {
      const atMax = [{ kind: 'field_accepts_value', field: fname, length: f.maxLength }];
      if (f.counterRequired === true) atMax.push({ kind: 'counter_shows', field: fname, expected: `${f.maxLength}/${f.maxLength}` });
      out.push(scn(`${fname}: accepts exactly ${f.maxLength} characters`, 'boundary',
        { [fname]: sampleValue(f, 'maxLen') }, atMax,
        [{ source: 'maxLength', value: f.maxLength }]));

      // Over-max: must be PREVENTED (rejected / truncated / not accepted past limit).
      out.push(scn(`${fname}: rejects/prevents more than ${f.maxLength} characters`, 'boundary',
        { [fname]: sampleValue(f, 'overMax') },
        [{ kind: 'value_rejected', field: fname, reason: 'over_max_length', limit: f.maxLength }],
        [{ source: 'maxLength', value: f.maxLength }], 'qa_standard'));
    }

    // Format validity (e.g. email).
    if (f.format) {
      out.push(scn(`${fname}: valid ${f.format} accepted`, 'success',
        { [fname]: sampleValue(f, 'validFormat') },
        [{ kind: 'field_accepts_value', field: fname }, { kind: 'page_present', page: 'saved' }]));
      out.push(scn(`${fname}: invalid ${f.format} rejected`, 'required_validation',
        { [fname]: sampleValue(f, 'invalidFormat') },
        [{ kind: 'format_rejected', field: fname, format: String(f.format) }], [], 'qa_standard'));
    }

    // A typical valid value saves + is displayed.
    out.push(scn(`${fname}: typical value saved and displayed`, 'success',
      { [fname]: sampleValue(f, 'typical') },
      [{ kind: 'field_accepts_value', field: fname }, { kind: 'element_present', label: `${fname} entry` }]));
  }

  // ── Business-rule-derived scenarios ───────────────────────────────────
  for (const r of rules) {
    if (!r || !r.kind) continue;
    switch (String(r.kind)) {
      case 'max_count': {
        if (!isPosInt(r.max)) break;   // review P2b — no numeric max -> no meaningful boundary scenario
        const n = r.max;
        const entity = String(r.entity || 'items');
        const control = String(r.control || `Add ${entity}`);
        const ev = [{ kind: 'item_count', entity, expected: n }, { kind: 'control_disabled', control }];
        if (r.message) ev.push({ kind: 'message_visible', textHint: String(r.message) });
        out.push(scn(`Max ${n} ${entity}: adding control disabled at the limit`, 'boundary',
          {}, ev, r.message ? [{ source: 'businessRule', value: String(r.message) }] : []));
        break;
      }
      case 'confirmation_required': {
        const action = String(r.action || 'delete');
        const msg = r.message ? String(r.message) : null;
        out.push(scn(`${action}: choosing "No" cancels (item remains)`, 'success', {},
          [{ kind: 'confirmation_visible', textHint: msg }, { kind: 'choice_outcome', choice: 'No', result: 'element_present' }],
          msg ? [{ source: 'businessRule', value: msg }] : []));
        out.push(scn(`${action}: choosing "Yes" completes (item removed)`, 'success', {},
          [{ kind: 'confirmation_visible', textHint: msg }, { kind: 'choice_outcome', choice: 'Yes', result: 'element_absent' }],
          msg ? [{ source: 'businessRule', value: msg }] : []));
        break;
      }
      case 'ordering': {
        out.push(scn(`${featureLabel}: entries shown in ${String(r.order || 'newest-first')} order`, 'success',
          {}, [{ kind: 'ordering_correct', order: String(r.order || 'newest_first') }]));
        break;
      }
      case 'edit_moves_to_top': {
        out.push(scn(`${featureLabel}: editing an older entry moves it to the top + updates timestamp`, 'success',
          {}, [{ kind: 'ordering_correct', order: 'edited_to_top' }, { kind: 'element_present', label: 'updated timestamp' }]));
        break;
      }
      case 'disabled_when_full': {
        const control = String(r.control || 'Add');
        out.push(scn(`${control} disabled when at capacity`, 'boundary', {},
          [{ kind: 'control_disabled', control }]));
        break;
      }
      default:
        break;
    }
  }

  return out.slice(0, MAX_GENERATED_SCENARIOS);
}

/**
 * Bridge to the Architect (ADO wiring). Render the behavior model + the
 * deterministically-generated scenario classes into a compact, structured
 * GROUNDING BLOCK the Architect consumes alongside the requirement clauses.
 *
 * The Architect's job becomes: author the STEPS that drive THIS site to exercise
 * each scenario class, and carry the listed requiredEvidence as the case's
 * acceptance contract. It no longer has to infer constraints (maxLength, max-5,
 * counter) from messy prose — they are given structured. Deterministic; the
 * Architect supplies only the site-specific step authoring (genuine novelty).
 */
function behaviorModelToGroundingBlock(model, scenarios) {
  if (!model || typeof model !== 'object') return '';
  const scns = Array.isArray(scenarios) ? scenarios : generateScenariosFromBehaviorModel(model);
  const lines = [];
  lines.push('## STRUCTURED BEHAVIOR MODEL (extracted from the work item)');
  if (model.actor) lines.push(`Actor: ${model.actor}`);
  if (model.feature) lines.push(`Feature: ${model.feature}`);
  if (Array.isArray(model.preconditions) && model.preconditions.length) lines.push(`Preconditions: ${model.preconditions.join('; ')}`);
  if (Array.isArray(model.actions) && model.actions.length) lines.push(`Actions: ${model.actions.join(', ')}`);

  if (Array.isArray(model.fields) && model.fields.length) {
    lines.push('Fields:');
    for (const f of model.fields) {
      const c = [];
      if (f.optional) c.push('optional');
      if (f.maxLength) c.push(`max ${f.maxLength} chars`);
      if (f.minLength) c.push(`min ${f.minLength} chars`);
      if (f.counterRequired) c.push('character counter shown');
      if (f.format) c.push(`format=${f.format}`);
      if (f.example) c.push(`e.g. ${f.example}`);
      lines.push(`  - ${f.name} (${f.role || 'input'})${c.length ? ': ' + c.join('; ') : ''}`);
    }
  }
  if (Array.isArray(model.businessRules) && model.businessRules.length) {
    lines.push('Business rules:');
    for (const r of model.businessRules) {
      const parts = [r.kind];
      if (r.entity) parts.push(`entity=${r.entity}`);
      if (r.max) parts.push(`max=${r.max}`);
      if (r.action) parts.push(`action=${r.action}`);
      if (r.control) parts.push(`control="${r.control}"`);
      if (r.order) parts.push(`order=${r.order}`);
      if (r.message) parts.push(`message="${r.message}"`);
      lines.push(`  - ${parts.join('; ')}`);
    }
  }

  lines.push('');
  lines.push('REQUIRED SCENARIO CLASSES — author ONE runnable case per class. Drive the live');
  lines.push('site with real steps to exercise each; the listed required evidence is the');
  lines.push('case acceptance (the verdict engine checks exactly these):');
  scns.forEach((s, i) => {
    lines.push(`  ${i + 1}. [${s.intentClass}] ${s.name}`);
    const dataKeys = Object.keys(s.inputs || {});
    if (dataKeys.length) {
      const dataStr = dataKeys.map((k) => {
        const v = String(s.inputs[k]);
        return `${k}=${v.length > 24 ? `<${v.length}-char value>` : JSON.stringify(v)}`;
      }).join(', ');
      lines.push(`       data: ${dataStr}`);
    }
    const ev = (s.requiredEvidence || []).map((e) => {
      const extra = [e.field, e.control, e.label, e.expected, e.textHint, e.choice, e.length]
        .filter((x) => x != null && x !== '').join(',');
      return extra ? `${e.kind}(${extra})` : e.kind;
    }).join('; ');
    if (ev) lines.push(`       required evidence: ${ev}`);
  });
  return lines.join('\n');
}

module.exports = { generateScenariosFromBehaviorModel, behaviorModelToGroundingBlock };
