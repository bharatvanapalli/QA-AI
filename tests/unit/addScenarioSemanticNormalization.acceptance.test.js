import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  buildAmbiguousDateFixture,
  buildCanonicalTemporalFixture,
  buildExactLiteralFixture,
  buildHarmlessAliasFixture,
  buildMeaningChangeFixture,
  buildSourceLiteralDriftFixture,
} from '../fixtures/addScenarioSemanticNormalization.fixture.js';

const require = createRequire(import.meta.url);
const projector = require('../../server/services/addScenarioSemanticProjector');
const validator = require('../../server/services/caseContractSemanticValidator');

function projectFixture(fixture) {
  return projector.projectSemanticPlan(fixture.plan, { sourceText: fixture.sourceText });
}

function validateFixture(envelope, fixture) {
  return validator.validateSemanticCaseContract(envelope, {
    sourceText: fixture.sourceText,
    maxSteps: 100,
  });
}

function captureProjectionError(fixture) {
  try {
    projectFixture(fixture);
  } catch (error) {
    return error;
  }
  throw new Error('Expected semantic projection to reject the fixture.');
}

describe('addScenario semantic normalization acceptance', () => {
  it('canonicalizes harmless whitespace, casing, and enum aliases only', () => {
    const fixture = buildHarmlessAliasFixture();
    const envelope = projectFixture(fixture);
    const [action] = envelope.cases[0].steps;
    const [assertion] = envelope.cases[0].assertions;

    expect(validateFixture(envelope, fixture)).toMatchObject({ ok: true, findings: [] });
    expect(action).toMatchObject({
      type: 'Click',
      text: 'Click the Continue control.',
      targetIdentity: {
        kind: 'control', label: 'Continue', role: 'button', scope: 'Main form',
      },
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    });
    expect(assertion).toMatchObject({
      type: 'AssertVisible',
      text: 'Verify the ready marker is visible.',
      comparator: 'visible',
      targetIdentity: { kind: 'region', label: 'ready marker', role: 'status' },
      failureBehavior: 'continue_independent',
    });
  });

  it('canonicalizes uniquely authored display dates and times without changing meaning', () => {
    const fixture = buildCanonicalTemporalFixture();
    const envelope = projectFixture(fixture);
    const [dateAction, timeAction] = envelope.cases[0].steps;
    const [dateAssertion, timeAssertion] = envelope.cases[0].assertions;

    expect(validateFixture(envelope, fixture)).toMatchObject({ ok: true, findings: [] });
    expect(dateAction).toMatchObject({ type: 'Date', value: '2026-08-20' });
    expect(timeAction).toMatchObject({ type: 'Time', value: '09:00' });
    expect(dateAssertion.payload.operands[1]).toMatchObject({
      kind: 'temporal', temporalType: 'date', value: '2026-08-20',
    });
    expect(timeAssertion.payload.operands[1]).toMatchObject({
      kind: 'temporal', temporalType: 'time', value: '09:00',
    });
  });

  it('preserves exact authored literals, punctuation, slashes, and leading zeroes', () => {
    const fixture = buildExactLiteralFixture();
    const envelope = projectFixture(fixture);
    const [fill, select] = envelope.cases[0].steps;
    const [assertion] = envelope.cases[0].assertions;

    expect(validateFixture(envelope, fixture)).toMatchObject({ ok: true, findings: [] });
    expect(fill.value).toBe(fixture.routingCode);
    expect(select.selectionCriteria).toEqual({ kind: 'exact_text', text: fixture.freightTerm });
    expect(assertion.payload.operands[1]).toMatchObject({
      role: 'expected', kind: 'text', value: fixture.routingCode,
    });
  });

  it('rejects an ambiguous authored date instead of choosing one candidate', () => {
    const error = captureProjectionError(buildAmbiguousDateFixture());

    expect(error).toBeInstanceOf(projector.AddScenarioSemanticProjectionError);
    expect(error.code).toBe('ADD_SCENARIO_SEMANTIC_PROJECTION_INVALID');
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_temporal_value_conflict' }),
    ]));
  });

  it('rejects selection migration and incompatible assertion relations instead of repairing meaning', () => {
    const error = captureProjectionError(buildMeaningChangeFixture());
    const codes = error.findings.map((finding) => finding.code);

    expect(error).toBeInstanceOf(projector.AddScenarioSemanticProjectionError);
    expect(codes).toContain('semantic_plan_selection_for_non_select');
    expect(codes).toContain('semantic_plan_assertion_relation_incompatible');
  });

  it('rejects an executable literal that is not linked to the authored source', () => {
    const error = captureProjectionError(buildSourceLiteralDriftFixture());

    expect(error).toBeInstanceOf(projector.AddScenarioSemanticProjectionError);
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_source_quote_literal_mismatch' }),
    ]));
  });
});
