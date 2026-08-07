import { describe, expect, it } from 'vitest';
import engine from '../../server/services/strictAssertionEngine';

const { evaluateAssertion } = engine;

function evaluate(kind, expected, channels, extra = {}) {
  return evaluateAssertion({
    assertion: { kind, expected, ...extra.assertion },
    evidence: { channels, ...extra.evidence },
    failurePolicy: extra.failurePolicy,
    sensitiveValues: extra.sensitiveValues,
  });
}

describe('strictAssertionEngine', () => {
  it('passes exact visible text only with exact target-scoped DOM evidence', () => {
    const result = evaluate('exact_visible_text', 'Welcome Workspace!', [{
      kind: 'dom_visible_text',
      text: 'Welcome Workspace!',
      visible: true,
      targetMatched: true,
      source: 'playwright_dom',
    }]);

    expect(result).toMatchObject({
      status: 'pass',
      evaluated: true,
      matched: true,
      expected: 'Welcome Workspace!',
      observed: 'Welcome Workspace!',
      source: 'playwright_dom',
      reason: 'exact_visible_text_matched',
    });
  });

  it('accepts accessibility visible-text proof and preserves exact mismatch as failure', () => {
    const result = evaluate('text', 'Expected heading', [{
      kind: 'ax_visible_text',
      value: 'Observed heading',
      exposed: true,
      exactTarget: true,
      source: 'cdp_accessibility',
    }]);

    expect(result).toMatchObject({
      status: 'fail',
      matched: false,
      expected: 'Expected heading',
      observed: 'Observed heading',
      source: 'cdp_accessibility',
      reason: 'exact_visible_text_mismatch',
    });
    expect(result.failurePolicy).toMatchObject({
      classification: 'validation_only',
      onFailure: 'record_and_continue',
      continueExecution: true,
      blockDependents: false,
      blockCase: false,
      blockRun: false,
    });
  });

  it('records a searched but absent exact text target as a non-blocking validation failure', () => {
    const result = evaluate('exact_visible_text', 'Welcome Workspace!', [{
      kind: 'dom_visible_text',
      text: null,
      visible: false,
      searched: true,
      targetMatched: true,
      source: 'playwright_exact_text_search',
    }]);

    expect(result).toMatchObject({
      status: 'fail',
      matched: false,
      reason: 'exact_visible_text_not_observed',
      failurePolicy: {
        classification: 'validation_only',
        onFailure: 'record_and_continue',
        blockDependents: false,
      },
    });
  });

  it('rejects visible DOM or AX text that is not scoped to the asserted target', () => {
    const dom = evaluate('exact_visible_text', 'Welcome Workspace!', [{
      kind: 'dom_visible_text',
      text: 'Welcome Workspace!',
      visible: true,
      source: 'page_wide_dom_text',
    }]);
    const ax = evaluate('exact_visible_text', 'Welcome Workspace!', [{
      kind: 'ax_visible_text',
      text: 'Welcome Workspace!',
      exposed: true,
      source: 'page_wide_ax_text',
    }]);

    expect(dom).toMatchObject({ status: 'uncheckable', reason: 'exact_visible_text_evidence_missing' });
    expect(ax).toMatchObject({ status: 'uncheckable', reason: 'exact_visible_text_evidence_missing' });
  });

  it.each([
    'fingerprint_changed',
    'active_page_changed',
    'navigation_event',
    'url_changed',
    'stable_destination_fingerprint',
  ])('never treats generic %s evidence as concrete assertion proof', (kind) => {
    const result = evaluate('exact_visible_text', 'Welcome Workspace!', [{
      kind,
      value: 'Welcome Workspace!',
      visible: true,
      targetMatched: true,
      source: kind,
    }]);

    expect(result).toMatchObject({
      status: 'uncheckable',
      evaluated: false,
      matched: null,
      observed: null,
      source: null,
      reason: 'exact_visible_text_evidence_missing',
    });
  });

  it('requires exact owner-control readback for a value assertion', () => {
    const weak = evaluate('exact_value', '007995145', [{
      kind: 'dom_visible_text',
      value: '007995145',
      visible: true,
      targetMatched: true,
    }]);
    const strong = evaluate('exact_value', '007995145', [{
      kind: 'owner_control_value',
      value: '007995145',
      ownerMatched: true,
      readback: true,
      source: 'playwright_input_value',
    }]);

    expect(weak).toMatchObject({ status: 'uncheckable', reason: 'owner_value_evidence_missing' });
    expect(strong).toMatchObject({
      status: 'pass',
      observed: '007995145',
      source: 'playwright_input_value',
      reason: 'owner_value_matched',
    });
  });

  it('requires owner-control readback for selected values', () => {
    const result = evaluate('selected_value', 'Inbound', [{
      kind: 'owner_selected_value',
      displayedValue: 'Inbound',
      ownerMatched: true,
      readback: true,
      source: 'dom_selected_label',
    }]);

    expect(result).toMatchObject({
      status: 'pass',
      assertionKind: 'exact_selected_value',
      observed: 'Inbound',
      reason: 'owner_selected_value_matched',
    });
  });

  it('requires stable target-scoped collection evidence for counts', () => {
    const unscoped = evaluate('count', 5, [{
      kind: 'scoped_collection',
      count: 5,
      stable: true,
      visible: true,
      scopeMatched: false,
    }]);
    const scoped = evaluate('count', 5, [{
      kind: 'scoped_collection',
      count: 5,
      stable: true,
      visible: true,
      scopeMatched: true,
      source: 'playwright_scoped_collection',
    }]);

    expect(unscoped).toMatchObject({ status: 'uncheckable', reason: 'scoped_count_evidence_missing' });
    expect(scoped).toMatchObject({
      status: 'pass',
      observed: 5,
      reason: 'scoped_count_matched',
    });
  });

  it('fails a scoped count mismatch without stopping independent execution', () => {
    const result = evaluate('count_matches', 61, [{
      kind: 'scoped_collection',
      count: 62,
      stable: true,
      visible: true,
      scopeMatched: true,
      source: 'dom_collection_count',
    }]);

    expect(result).toMatchObject({
      status: 'fail',
      expected: 61,
      observed: 62,
      reason: 'scoped_count_mismatch',
      failurePolicy: {
        classification: 'validation_only',
        continueIndependent: true,
        blockDependents: false,
      },
    });
  });

  it('requires a stable visible scoped list and validates exact ordering', () => {
    const expected = ['RR', 'LCL', 'LTL', 'TL', 'FCL'];
    const pass = evaluate('collection_exact_order', expected, [{
      kind: 'scoped_collection',
      items: expected,
      stable: true,
      visible: true,
      scopeMatched: true,
      source: 'ax_listbox_options',
    }]);
    const fail = evaluate('ordered_list', expected, [{
      kind: 'scoped_collection',
      items: ['RR', 'LTL', 'LCL', 'TL', 'FCL'],
      stable: true,
      visible: true,
      scopeMatched: true,
      source: 'ax_listbox_options',
    }]);
    const unstable = evaluate('ordered_list', expected, [{
      kind: 'scoped_collection',
      items: expected,
      stable: false,
      visible: true,
      scopeMatched: true,
    }]);

    expect(pass).toMatchObject({ status: 'pass', reason: 'ordered_list_matched' });
    expect(fail).toMatchObject({ status: 'fail', reason: 'ordered_list_mismatch' });
    expect(unstable).toMatchObject({ status: 'uncheckable', reason: 'stable_ordered_list_evidence_missing' });
  });

  it('evaluates chronological relationships only from typed, scoped owner readbacks', () => {
    const result = evaluate('chronological_relationship', {
      operator: 'before',
      leftTarget: 'Early Pickup Date/Time',
      rightTarget: 'Late Pickup Date/Time',
    }, [{
      kind: 'temporal_relationship',
      left: { type: 'datetime', value: '2026-08-20T09:00:00-05:00' },
      right: { type: 'datetime', value: '2026-08-20T11:00:00-05:00' },
      leftTargetMatched: true,
      rightTargetMatched: true,
      leftReadback: true,
      rightReadback: true,
      source: 'owner_control_datetime_readback',
    }]);

    expect(result).toMatchObject({
      assertionKind: 'relationship',
      status: 'pass',
      observed: {
        operator: 'before',
        valueType: 'datetime',
        left: '2026-08-20T09:00:00-05:00',
        right: '2026-08-20T11:00:00-05:00',
      },
      source: 'owner_control_datetime_readback',
      reason: 'typed_relationship_matched',
    });
  });

  it('records a typed relationship mismatch as a validation failure and continues', () => {
    const result = evaluate('relationship', { operator: 'before' }, [{
      kind: 'typed_relationship',
      left: { type: 'time', value: '03:00 PM' },
      right: { type: 'time', value: '01:00 PM' },
      scopeMatched: true,
      readback: true,
      source: 'owner_control_time_readback',
    }]);

    expect(result).toMatchObject({
      status: 'fail',
      matched: false,
      reason: 'typed_relationship_mismatch',
      failurePolicy: {
        classification: 'validation_only',
        onFailure: 'record_and_continue',
        continueExecution: true,
        blockDependents: false,
      },
    });
  });

  it('rejects untyped, unscoped, and generic relationship evidence', () => {
    const result = evaluate('relationship', { operator: 'before' }, [
      {
        kind: 'typed_relationship',
        leftValue: '2026-08-20T09:00:00-05:00',
        rightValue: '2026-08-20T11:00:00-05:00',
        scopeMatched: true,
        readback: true,
      },
      {
        kind: 'typed_relationship',
        left: { type: 'datetime', value: '2026-08-20T09:00:00-05:00' },
        right: { type: 'datetime', value: '2026-08-20T11:00:00-05:00' },
        readback: true,
      },
      {
        kind: 'navigation_event',
        left: { type: 'datetime', value: '2026-08-20T09:00:00-05:00' },
        right: { type: 'datetime', value: '2026-08-20T11:00:00-05:00' },
        scopeMatched: true,
        readback: true,
      },
    ]);

    expect(result).toMatchObject({
      status: 'uncheckable',
      evaluated: false,
      reason: 'typed_relationship_evidence_missing',
    });
  });

  it('distinguishes visual tooltip proof from semantic tooltip proof', () => {
    const visual = evaluate('tooltip', 'User Management', [{
      kind: 'visual_tooltip',
      text: 'User Management',
      visible: true,
      targetMatched: true,
      source: 'rendered_tooltip_dom',
    }]);
    const semantic = evaluate('tooltip_visible', 'User Management', [{
      kind: 'semantic_tooltip',
      text: 'User Management',
      relationship: 'aria-describedby',
      targetMatched: true,
      source: 'accessibility_relationship',
    }]);

    expect(visual).toMatchObject({
      status: 'pass',
      proofType: 'visual',
      visualCaptured: true,
      reason: 'tooltip_visual_matched',
    });
    expect(semantic).toMatchObject({
      status: 'pass',
      proofType: 'semantic',
      visualCaptured: false,
      reason: 'tooltip_semantic_matched_no_visual_capture',
    });
  });

  it('does not accept appeared-after-hover text without tooltip semantics', () => {
    const result = evaluate('tooltip', 'User Management', [{
      kind: 'dom_visible_text',
      text: 'User Management',
      visible: true,
      targetMatched: true,
      appearedAfterHover: true,
      source: 'post_hover_snapshot',
    }]);

    expect(result).toMatchObject({
      status: 'uncheckable',
      proofType: null,
      visualCaptured: false,
      reason: 'tooltip_evidence_missing',
    });
  });

  it('never lets semantic tooltip evidence prove a normal visible-text assertion', () => {
    const result = evaluate('exact_visible_text', 'User Management', [{
      kind: 'semantic_tooltip',
      text: 'User Management',
      relationship: 'aria-describedby',
      targetMatched: true,
      semantic: true,
      source: 'accessibility_relationship',
    }]);

    expect(result).toMatchObject({
      status: 'uncheckable',
      reason: 'exact_visible_text_evidence_missing',
    });
  });

  it('requires exact target-scoped DOM or AX proof for normal visibility checks', () => {
    const passed = evaluate('visible', true, [{
      kind: 'dom_visibility', visible: true, targetMatched: true, source: 'exact_target_dom',
    }]);
    const missing = evaluate('visible', true, [{
      kind: 'stable_destination_fingerprint', visible: true, targetMatched: true, source: 'page',
    }]);
    const failed = evaluate('visible', true, [{
      kind: 'ax_visibility', visible: false, targetMatched: true, source: 'accessibility',
    }]);

    expect(passed).toMatchObject({ status: 'pass', matched: true, reason: 'exact_visibility_matched' });
    expect(missing).toMatchObject({ status: 'uncheckable', reason: 'exact_visibility_evidence_missing' });
    expect(failed).toMatchObject({
      status: 'fail', matched: false, reason: 'exact_visibility_mismatch',
      failurePolicy: { onFailure: 'record_and_continue', blockCase: false, blockRun: false },
    });
  });

  it('treats hidden as an exact false visibility assertion', () => {
    const result = evaluate('hidden', undefined, [{
      kind: 'dom_visibility', visible: false, targetMatched: true, source: 'exact_target_dom',
    }]);
    expect(result).toMatchObject({ status: 'pass', matched: true, expected: undefined, observed: false });
  });

  it('marks required action failures as dependent-only blocks', () => {
    const result = evaluate('exact_selected_value', 'LTL', [{
      kind: 'owner_selected_value',
      value: 'RR',
      ownerMatched: true,
      readback: true,
      source: 'control_readback',
    }], { failurePolicy: 'required_action' });

    expect(result).toMatchObject({
      status: 'fail',
      failurePolicy: {
        classification: 'required_action',
        onFailure: 'block_dependents_only',
        continueExecution: true,
        continueIndependent: true,
        blockDependents: true,
        blockCase: false,
        blockRun: false,
      },
    });
  });

  it('marks dependency evidence gaps as dependent-only blocks', () => {
    const result = evaluate('exact_value', 'ready', [], { failurePolicy: 'block_dependents' });

    expect(result).toMatchObject({
      status: 'uncheckable',
      failurePolicy: {
        classification: 'dependency',
        blockDependents: true,
        blockCase: false,
        blockRun: false,
      },
    });
  });

  it('returns uncheckable when concrete proof channels disagree', () => {
    const result = evaluate('exact_visible_text', 'Ready', [
      {
        kind: 'dom_visible_text', text: 'Ready', visible: true, targetMatched: true, source: 'dom',
      },
      {
        kind: 'ax_visible_text', text: 'Loading', exposed: true, targetMatched: true, source: 'ax',
      },
    ]);

    expect(result).toMatchObject({
      status: 'uncheckable',
      observed: ['Ready', 'Loading'],
      source: 'dom + ax',
      reason: 'conflicting_exact_visible_text_evidence',
    });
  });

  it('redacts expected and observed secret values while preserving diagnostics', () => {
    const secret = 'Do-not-persist-this-secret';
    const result = evaluate('exact_value', secret, [{
      kind: 'owner_control_value',
      value: secret,
      ownerMatched: true,
      readback: true,
      source: `secure_readback:${secret}`,
    }], {
      assertion: { target: 'Account password field', sensitive: true },
    });

    expect(result).toMatchObject({
      status: 'pass',
      expected: '[REDACTED]',
      observed: '[REDACTED]',
      source: 'secure_readback:[REDACTED]',
      reason: 'owner_value_matched',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns unsupported assertion kinds as uncheckable with safe continuation', () => {
    const result = evaluate('visual_similarity_guess', 'anything', [{
      kind: 'fingerprint_changed',
      value: true,
    }]);

    expect(result).toMatchObject({
      status: 'uncheckable',
      evaluated: false,
      reason: 'assertion_kind_unsupported',
      failurePolicy: {
        classification: 'validation_only',
        continueExecution: true,
        blockDependents: false,
      },
    });
  });
});
