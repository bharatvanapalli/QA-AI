import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import comparator from '../../server/services/reliability/benchmarkComparator.js';
import pipeline from '../../server/services/reliability/selfHealingPipeline.js';
import identity from '../../server/services/reliability/coverageIdentityMap.js';
import semantic from '../../server/services/reliability/semanticFieldMapper.js';
import contracts from '../../server/services/reliability/contracts.js';
import architect from '../../server/services/agents/architect.js';

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/v12-regression-suite.json'), 'utf8'));

describe('V12 scenario-generation regression guards', () => {
  it('does not match coverage ownership by fuzzy title/module text', () => {
    const map = identity.buildCoverageIdentityMap(fixture.manifest);
    const unrelatedCase = {
      id: 'pim-case',
      name: 'Leave List filter by date and status wording copied into PIM',
      module: 'PIM',
      steps: [{ action: 'Navigate', target: 'PIM Employee List page' }],
    };

    expect(identity.caseMatchesCoverage(unrelatedCase, 'leave-list-filters', map)).toBe(false);
    expect(pipeline.matchCoverageItem(unrelatedCase, { module: 'PIM' }, fixture.manifest.items, map)).toBe(null);
  });

  it('flags explicit but semantically wrong coverage ownership', () => {
    const defects = contracts.collectCaseReliabilityDefects({
      id: 'wrong-owner-case',
      name: 'Admin search wrongly stamped as Leave List',
      module: 'Admin',
      coverageRefs: ['cov::req-leave-list::standard'],
      dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
      steps: [
        { action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
        { action: 'Click', target: 'Search button' },
        { action: 'Verify', target: 'System Users results table', verify: { kind: 'text', target: 'System Users results table', expected: 'matching user row' } },
      ],
      oracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story' }],
    }, { module: 'Admin' }, { coverageManifest: fixture.manifest });

    expect(defects.some((defect) => defect.code === 'wrong_coverage_owner')).toBe(true);
  });

  it('normalizes filter field labels without leaking UI suffixes into tokens', () => {
    expect(semantic.semanticTokenForPurpose('business search field', 'Username filter field')).toBe('usernamefilter');
    expect(semantic.semanticTokenForPurpose('business search field', 'Username search field')).toBe('usernamefilter');
    expect(semantic.canonicalizeTokenExpression('{{usernamesearch}}', { purpose: 'business search field' })).toBe('{{usernamefilter}}');
    expect(semantic.canonicalizeTokenExpression('{{username_search}}', { purpose: 'business search field' })).toBe('{{usernamefilter}}');
    expect(semantic.semanticTokenForPurpose('business search field', 'User Role filter field')).toBe('userrolefilter');
    expect(semantic.semanticTokenForPurpose('business search field', 'Status filter field')).toBe('statusfilter');
    expect(semantic.semanticTokenForPurpose('auth field', 'Login Username')).toBe('loginusername');
    expect(semantic.semanticTokenForPurpose('module gate field', 'Maintenance password')).toBe('modulegatepassword');
  });

  it('self-heals stale V12 artifacts into scoped data-choice status with required oracle and row intent', async () => {
    const result = await pipeline.runGenerationSelfHealingPipeline({
      manifest: fixture.manifest,
      scenarios: fixture.suite,
      enableTargetedRepair: true,
    });
    const healedCase = result.scenarios[0].cases[0];
    const phase45 = healedCase.qualityContract.phase45;

    expect(phase45.status).toBe('Needs data choice');
    expect(phase45.unresolvedDefects.some((defect) => defect.code === 'token_collision')).toBe(false);
    expect(JSON.stringify(healedCase.steps)).not.toContain('usernamefilterfield');
    expect(JSON.stringify(healedCase.steps)).toContain('usernamefilter');
    expect(phase45.rowExecutionPlan.rowIntents).toContain('positive');
    expect(phase45.rowExecutionPlan.rows[0].intent).toBe('positive');
    expect(phase45.structuredOracles.some((oracle) => (
      oracle.kind === 'table_row'
      && oracle.target === 'System Users results table'
    ))).toBe(true);

    const benchmark = comparator.compareScenarioBenchmark({
      scenarios: result.scenarios,
      expected: {
        id: 'v12-admin-regression',
        items: [{
          coverageRef: 'admin-system-user-search',
          requiredFields: ['username', 'role', 'employee name', 'status'],
          requiredOracles: [{ kind: 'table_row', target: 'System Users results table' }],
          dataRowIntents: ['positive'],
        }],
      },
      context: { coverageManifest: fixture.manifest },
    });

    expect(benchmark.ok).toBe(true);
  });

  it('canonicalizes mixed coverage refs into one primary and supporting refs', async () => {
    const result = await pipeline.runGenerationSelfHealingPipeline({
      manifest: fixture.manifest,
      scenarios: [{
        name: 'Admin mixed coverage refs',
        module: 'Admin',
        cases: [{
          id: 'mixed-coverage-case',
          name: 'System user search returns expected result',
          module: 'Admin',
          coverageRefs: ['cov::req-leave-list::standard', 'cov::req-admin-search::standard'],
          dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
          steps: [
            { action: 'Fill', target: 'Username search field', value: '{{usernamesearch}}' },
            { action: 'Click', target: 'Search button' },
          ],
        }],
      }],
      enableTargetedRepair: true,
    });

    const healedCase = result.scenarios[0].cases[0];
    const phase45 = healedCase.qualityContract.phase45;
    expect(healedCase.coverageRefs).toEqual(['cov::req-admin-search::standard']);
    expect(healedCase.primaryCoverageRef).toBe('cov::req-admin-search::standard');
    expect(healedCase.supportingCoverageRefs).toContain('cov::req-leave-list::standard');
    expect(phase45.primaryCoverageRef).toBe('cov::req-admin-search::standard');
    expect(phase45.supportingCoverageRefs).toContain('cov::req-leave-list::standard');
    expect(phase45.primaryStoryId).toBe('US-OHRM-ADMIN-SEARCH');
    expect(JSON.stringify(healedCase.steps)).not.toContain('usernamesearch');
    expect(JSON.stringify(healedCase.steps)).toContain('usernamefilter');
  });

  it('keeps deterministic contract-pack fallback automatable with valid assertions', () => {
    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'cov::req-admin-search::standard',
      aliases: ['admin-system-user-search'],
      storyId: 'US-OHRM-ADMIN-SEARCH',
      module: 'Admin',
      title: 'System user search returns expected result',
      pageIntent: 'Admin System Users page',
      requiredFields: ['username', 'role', 'employee name', 'status'],
      requiredActions: ['search'],
      requiredOracles: [{
        kind: 'table_row',
        target: 'System Users results table',
        expected: 'matching user row',
        source: 'case_contract_pack',
        required: true,
      }],
      semanticTokens: {
        username: '{{usernamefilter}}',
        role: '{{userrolefilter}}',
        employeename: '{{employeename}}',
        status: '{{statusfilter}}',
      },
      rowIntent: {
        sheet: 'Admin_SystemUserSearch',
        rowSelector: 'all',
        rowIds: ['row-1'],
      },
      allowedPages: ['Admin System Users page'],
    }, 'provider_timeout');

    const generatedCase = scenario.cases[0];
    expect(generatedCase.name).toBe('System user search returns expected result');
    expect(generatedCase.name).not.toMatch(/contract fallback/i);
    expect(generatedCase.automatability).toBe('automatable');
    expect(generatedCase.steps.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(generatedCase.steps)).toContain('{{usernamefilter}}');
    expect(JSON.stringify(generatedCase.steps)).not.toContain('{{{{usernamefilter}}}}');
    expect(JSON.stringify(generatedCase.steps)).toContain('Search button');
    const inputSteps = generatedCase.steps.filter((step) => ['Fill', 'Select'].includes(step.action));
    expect(inputSteps.length).toBeGreaterThan(0);
    expect(inputSteps.every((step) => Array.isArray(step.dataLineage) && step.dataLineage.length > 0)).toBe(true);
    expect(generatedCase.dataBinding.columnToField.usernamefilter).toBe('username');
    expect(generatedCase.rowExecutionPlan.rowIds).toEqual(['row-1']);
    expect(generatedCase.declaredAssertions[0]).toMatchObject({
      type: 'TEXT',
      payload: { expectedText: 'matching user row' },
    });

    architect.markMalformedAssertionPayloads([scenario]);
    const demotion = architect.demoteZeroAssertionAutomation([scenario]);
    expect(generatedCase.declaredAssertions[0].parseFailed).not.toBe(true);
    expect(demotion.demotedCount).toBe(0);
    expect(generatedCase.automatability).toBe('automatable');
  });

  it('includes lower-priority missing-capability packs when needed to meet the scenario floor', () => {
    const packs = pipeline.buildCaseContractPacks({
      targetPackCount: 3,
      manifest: {
        items: [
          {
            coverageRef: 'required-admin-search',
            required: true,
            module: 'Admin',
            title: 'Required Admin Search',
            requiredFields: ['username'],
            requiredOracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row' }],
          },
          {
            coverageRef: 'optional-pim',
            required: false,
            module: 'PIM',
            title: 'Optional PIM case',
            requiredFields: ['employee id'],
            requiredOracles: [{ kind: 'visible', target: 'Employee table', expected: true }],
          },
          {
            coverageRef: 'missing-directory-capability',
            type: 'missing_capability',
            required: false,
            module: 'Directory',
            title: 'Directory capability needs clarification',
            requiredFields: ['employee name'],
            requiredOracles: [{ kind: 'visible', target: 'Directory result', expected: true }],
          },
        ],
      },
    });

    expect(packs.map((pack) => pack.coverageRef)).toEqual([
      'required-admin-search',
      'optional-pim',
      'missing-directory-capability',
    ]);
    expect(packs[2].missingCapability).toBe(true);
  });
});
