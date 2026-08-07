import { describe, expect, it } from 'vitest';
import comparator from '../../server/services/reliability/benchmarkComparator.js';
import pipeline from '../../server/services/reliability/selfHealingPipeline.js';
import status from '../../server/services/reliability/scenarioGenerationStatus.js';
import executionReadiness from '../../server/services/executionReadinessCompiler.js';

describe('V11 scenario-generation regression guards', () => {
  const manifest = {
    items: [{
      manifestItemId: 'cov::req-admin-search::standard',
      title: 'Admin system user search by username, role, employee name, and status',
      module: 'Admin',
      required: true,
      storyRef: { id: 'US-OHRM-ADMIN-SEARCH', title: 'Search system users' },
      requiredFields: ['username', 'role', 'employee name', 'status'],
      requiredOracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story', required: true }],
      dataSource: {
        sheet: 'Admin_SystemUserSearch',
        rows: ['row-1'],
        rowSelector: 'positive',
        placeholders: ['usernamefilter', 'userrolefilter', 'employeename', 'statusfilter'],
      },
    }],
  };

  it('does not fail benchmark coverage only because friendly aliases differ from internal refs', () => {
    const result = comparator.compareScenarioBenchmark({
      expected: {
        id: 'orangehrm-admin',
        items: [{
          coverageRef: 'admin-system-user-search',
          requiredFields: ['username', 'role', 'employee name', 'status'],
          requiredOracles: [{ kind: 'table_row', target: 'System Users results table' }],
          dataRowIntents: ['positive'],
        }],
      },
      context: { coverageManifest: manifest },
      scenarios: [{
        module: 'Admin',
        cases: [{
          id: 'admin-case',
          name: 'Admin system user search',
          coverageRefs: ['cov::req-admin-search::standard'],
          dataBinding: { rowIntent: 'positive' },
          steps: [
            { action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
            { action: 'Select', target: 'User Role filter', value: '{{userrolefilter}}' },
            { action: 'Fill', target: 'Employee Name filter', value: '{{employeename}}' },
            { action: 'Select', target: 'Status filter', value: '{{statusfilter}}' },
            { action: 'Verify', target: 'System Users results table', verify: { kind: 'text', text: 'matching user row' } },
          ],
          oracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'story' }],
        }],
      }],
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('writes phase45 quality contract details during self-healing', async () => {
    const result = await pipeline.runGenerationSelfHealingPipeline({
      manifest,
      scenarios: [{
        name: 'Admin System User Search',
        module: 'Admin',
        cases: [{
          id: 'admin-case',
          name: 'Admin search with legacy username token',
          module: 'Admin',
          dataBinding: { sheet: 'Admin_SystemUserSearch', source: 'proposed' },
          steps: [
            { action: 'Fill', target: 'Username', value: '{{username}}' },
            { action: 'Click', target: 'Search button', verify: { kind: 'none' }, expected: 'page ready' },
          ],
        }],
      }],
      enableTargetedRepair: true,
    });

    const phase45 = result.scenarios[0].cases[0].qualityContract.phase45;
    expect(phase45.selfHealed).toBe(true);
    expect(phase45.status).toBeTruthy();
    expect(phase45.coverageRefs).toContain('cov::req-admin-search::standard');
    expect(phase45.coverageAliases).toContain('admin-system-user-search');
    expect(phase45.rowExecutionPlan.rowIds).toEqual(['row-1']);
    expect(phase45.dataLineage.length).toBeGreaterThan(0);
    expect(phase45.structuredOracles.length).toBeGreaterThan(0);
  });

  it('shows proposed data as Needs data choice instead of a fake Good state', () => {
    const userStatus = status.computeScenarioGenerationStatus({}, [{
      code: 'proposed_data_mapping',
      family: 'data_binding',
      severity: 'user_decision_required',
      resolutionStatus: 'open',
    }]);

    expect(userStatus).toBe('Needs data choice');
  });

  it('does not treat Maintenance password gate steps as login setup', () => {
    const maintenanceCase = {
      id: 'maintenance-case',
      name: 'Maintenance password gate',
      module: 'Maintenance',
      steps: [
        { action: 'Fill', target: 'Password field', value: '{{modulegatepassword}}' },
        { action: 'Click', target: 'Confirm button' },
      ],
    };

    expect(executionReadiness.caseHasLoginSetup(maintenanceCase)).toBe(false);
    expect(executionReadiness.harvestLoginTemplate([{ cases: [maintenanceCase] }])).toBe(null);
  });
});
