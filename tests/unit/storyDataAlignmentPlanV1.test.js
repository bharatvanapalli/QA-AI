import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const datasetContract = require('../../server/services/datasetContractV1');
const alignmentPlan = require('../../server/services/storyDataAlignmentPlanV1');

function mappingFor(sheets) {
  return {
    mappingId: 'mapping-one',
    version: 1,
    status: 'approved',
    mapping: {
      bindings: sheets.map((sheet) => ({
        sheet: sheet.name,
        purpose: sheet.purpose,
        module: sheet.module,
        columnToField: sheet.columnToField || {},
        sensitivity: sheet.sensitivity || {},
      })),
    },
  };
}

function buildDataset({ id = 'dataset-one', sheets, mappings = [] }) {
  return datasetContract.buildDatasetContractV1({
    testDataSetId: id,
    projectId: 'project-one',
    sourceName: `${id}.xlsx`,
    parsedSheets: sheets,
    mappingSnapshot: mappings.length ? mappingFor(mappings) : null,
  });
}

function storySheet(name, storyId, intent, expected, extra = {}) {
  return {
    name,
    headers: ['Story ID', 'Intent', 'Account', 'Expected Result'],
    rows: [{
      'Story ID': storyId,
      Intent: intent,
      Account: extra.account || 'source-value-must-not-leak',
      'Expected Result': expected,
    }],
  };
}

describe('StoryDataAlignmentPlanV1', () => {
  it('selects all exact story-id row groups before scenario planning', () => {
    const sheets = [
      storySheet('Order happy paths', 'US-ORD-101', 'positive', 'Order accepted'),
      storySheet('Order rejection paths', 'US-ORD-101', 'negative', 'Order rejected'),
      {
        name: 'Authentication profiles',
        headers: ['Username', 'Password'],
        rows: [{ Username: 'user@example.test', Password: 'Never-Persist-This-Secret' }],
      },
    ];
    const dataset = buildDataset({
      sheets,
      mappings: [
        { name: 'Order happy paths', purpose: 'data_matrix', module: 'orders' },
        { name: 'Order rejection paths', purpose: 'negative_validation', module: 'orders' },
        { name: 'Authentication profiles', purpose: 'auth_profiles', module: 'identity' },
      ],
    });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      requirementRevision: 'req-rev-1',
      clauses: [
        { clauseId: 'clause-a', storyId: 'us_ord_101', module: 'orders', title: 'Submit an order' },
        { clauseId: 'clause-b', storyId: 'US-ORD-101', module: 'orders', title: 'Reject an invalid order' },
      ],
      datasetContracts: [dataset],
    });
    const alignment = plan.alignments[0];

    expect(plan.alignments).toHaveLength(1);
    expect(alignment.status).toBe('aligned_explicit');
    expect(alignment.clauseIds).toEqual(['clause-a', 'clause-b']);
    expect(alignment.selected).toHaveLength(2);
    expect(alignment.selected.every((item) => item.matchKind === 'story_id' && item.score === 1)).toBe(true);
    expect(plan.supportingSources).toHaveLength(1);
    expect(plan.supportingSources[0]).toEqual(expect.objectContaining({ supportReason: 'auth_profile', scenarioDriving: false }));
    expect(alignmentPlan.validateStoryDataAlignmentPlanV1(plan).ok).toBe(true);
  });

  it('reports workbook story ids that do not exist in the uploaded requirements', () => {
    const dataset = buildDataset({
      sheets: [storySheet('Known and unknown', 'US-OTHER-999', 'positive', 'Accepted')],
    });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{ clauseId: 'clause-known', storyId: 'US-KNOWN-001', title: 'Known story' }],
      datasetContracts: [dataset],
    });

    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      code: 'unknown_explicit_story_id',
      storyId: 'US-OTHER-999',
    }));
    expect(plan.alignments[0].status).toBe('unmapped');
    expect(plan.alignments[0].selected).toEqual([]);
  });

  it('uses metadata semantics only when one candidate clears both score and margin thresholds', () => {
    const sheets = [{
      name: 'Checkout refund',
      headers: ['Refund Amount', 'Payment Method', 'Expected Result'],
      rows: [{
        'Refund Amount': '100.00',
        'Payment Method': 'card',
        'Expected Result': 'Refund succeeds',
      }],
    }];
    const dataset = buildDataset({
      sheets,
      mappings: [{
        name: 'Checkout refund',
        purpose: 'data_matrix',
        module: 'payments',
        columnToField: { refundAmount: 'Refund Amount', paymentMethod: 'Payment Method' },
      }],
    });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{
        clauseId: 'refund-clause',
        module: 'payments',
        title: 'Checkout refund payment amount succeeds',
        behaviourText: 'Refund the payment method and verify the expected result',
      }],
      datasetContracts: [dataset],
    });
    const alignment = plan.alignments[0];

    expect(alignment.status).toBe('aligned_semantic');
    expect(alignment.selected).toHaveLength(1);
    expect(alignment.selected[0].score).toBeGreaterThanOrEqual(0.55);
    expect(alignment.selected[0].margin).toBeGreaterThanOrEqual(0.15);
    expect(alignment.selected[0].matchKind).toBe('semantic_metadata');
  });

  it('does not pick the first candidate when semantic candidates tie', () => {
    const sheets = [
      {
        name: 'Refund checkout east',
        headers: ['Refund Amount', 'Expected Result'],
        rows: [{ 'Refund Amount': '10', 'Expected Result': 'Refund complete' }],
      },
      {
        name: 'Refund checkout west',
        headers: ['Refund Amount', 'Expected Result'],
        rows: [{ 'Refund Amount': '20', 'Expected Result': 'Refund complete' }],
      },
    ];
    const dataset = buildDataset({ sheets });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{ clauseId: 'refund-clause', title: 'Refund checkout amount' }],
      datasetContracts: [dataset],
    });
    const alignment = plan.alignments[0];

    expect(alignment.status).toBe('ambiguous');
    expect(alignment.selected).toEqual([]);
    expect(alignment.candidates).toHaveLength(2);
    expect(alignment.decision.margin).toBe(0);
    expect(plan.unused.rowGroups).toHaveLength(2);
  });

  it('blocks an exact story-id match declared for a different module', () => {
    const sheet = storySheet('Payment action', 'US-PAY-001', 'positive', 'Payment accepted');
    const dataset = buildDataset({
      sheets: [sheet],
      mappings: [{ name: 'Payment action', purpose: 'data_matrix', module: 'payments' }],
    });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{ clauseId: 'billing-clause', storyId: 'US-PAY-001', module: 'billing', title: 'Bill account' }],
      datasetContracts: [dataset],
    });

    expect(plan.alignments[0].status).toBe('conflict');
    expect(plan.alignments[0].selected).toEqual([]);
    expect(plan.conflicts).toContainEqual(expect.objectContaining({ code: 'explicit_story_cross_module' }));
  });

  it('marks identical row-group content from different dataset revisions as ambiguous source history', () => {
    const target = storySheet('Order data', 'US-ORD-101', 'positive', 'Order accepted');
    const first = buildDataset({ id: 'dataset-rev-a', sheets: [target] });
    const second = buildDataset({
      id: 'dataset-rev-b',
      sheets: [
        target,
        {
          name: 'Revision note data',
          headers: ['Note', 'Expected Result'],
          rows: [{ Note: 'revision marker', 'Expected Result': 'Recorded' }],
        },
      ],
    });
    expect(first.datasetRevisionId).not.toBe(second.datasetRevisionId);

    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{ clauseId: 'order-clause', storyId: 'US-ORD-101', title: 'Submit order' }],
      datasetContracts: [first, second],
    });

    expect(plan.alignments[0].status).toBe('conflict');
    expect(plan.alignments[0].selected).toEqual([]);
    expect(plan.conflicts).toContainEqual(expect.objectContaining({ code: 'ambiguous_duplicate_source_revision' }));
  });

  it('keeps auth and no-oracle sheets as support-only inputs, not scenario drivers', () => {
    const dataset = buildDataset({
      sheets: [
        {
          name: 'Login identities',
          headers: ['Username', 'Password'],
          rows: [{ Username: 'identity@example.test', Password: 'Identity-Secret' }],
        },
        {
          name: 'Regional reference',
          headers: ['Region', 'Currency'],
          rows: [{ Region: 'west', Currency: 'USD' }],
        },
      ],
    });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{ clauseId: 'login-clause', title: 'Authenticate and view a regional price' }],
      datasetContracts: [dataset],
    });

    expect(plan.supportingSources).toHaveLength(2);
    expect(plan.supportingSources.map((item) => item.supportReason).sort()).toEqual(['auth_profile', 'no_oracle_reference']);
    expect(plan.alignments[0].selected).toEqual([]);
    expect(plan.stats.selectedRowGroupCount).toBe(0);
  });

  it('produces deterministic, value-free coverage items and exact case bindings', () => {
    const dataset = buildDataset({
      sheets: [storySheet('Account update', 'US-ACC-010', 'positive', 'Account updated', {
        account: 'Sensitive-Account-Value',
      })],
    });
    const input = {
      requirementRevision: 'requirements-sha-1',
      clauses: [{ clauseId: 'account-clause', storyId: 'US-ACC-010', title: 'Update account' }],
      datasetContracts: [dataset],
    };
    const first = alignmentPlan.buildStoryDataAlignmentPlanV1(input);
    const second = alignmentPlan.buildStoryDataAlignmentPlanV1(input);
    const coverage = alignmentPlan.toCoverageItems(first);
    const stamped = alignmentPlan.stampCaseBinding({ id: 'case-one', dataBinding: {} }, first, {
      alignmentId: first.alignments[0].alignmentId,
      rowGroupId: first.alignments[0].selected[0].rowGroupId,
    });

    expect(second).toEqual(first);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toEqual(expect.objectContaining({
      planId: first.planId,
      storyId: 'US-ACC-010',
      datasetRevisionId: dataset.datasetRevisionId,
      rowGroupId: first.alignments[0].selected[0].rowGroupId,
    }));
    expect(stamped.dataBinding).toEqual(expect.objectContaining({
      alignmentPlanId: first.planId,
      storyId: 'US-ACC-010',
      datasetRevisionId: dataset.datasetRevisionId,
    }));
    expect(JSON.stringify(first)).not.toContain('Sensitive-Account-Value');
    expect(JSON.stringify(first)).not.toContain('Account updated');
    expect(alignmentPlan.validateStoryDataAlignmentPlanV1(first).ok).toBe(true);
  });

  it('refuses to stamp a case when the selected row group is not unique', () => {
    const dataset = buildDataset({
      sheets: [
        storySheet('Path one', 'US-MULTI-001', 'positive', 'First result'),
        storySheet('Path two', 'US-MULTI-001', 'negative', 'Second result'),
      ],
    });
    const plan = alignmentPlan.buildStoryDataAlignmentPlanV1({
      clauses: [{ clauseId: 'multi-clause', storyId: 'US-MULTI-001', title: 'Multiple paths' }],
      datasetContracts: [dataset],
    });

    expect(() => alignmentPlan.stampCaseBinding({ id: 'case-one' }, plan)).toThrow(/ambiguous/i);
  });
});
