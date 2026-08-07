import { describe, expect, it } from 'vitest';
import capabilityMap from '../../server/services/reliability/capabilityMap.js';
import contracts from '../../server/services/reliability/contracts.js';
import promotion from '../../server/services/reliability/promotion.js';

describe('app capability grounding', () => {
  it('builds an AppCapabilityMap with executable locator evidence', () => {
    const map = capabilityMap.buildAppCapabilityMap({
      projectId: 'orangehrm',
      modules: ['Admin'],
      pages: [{
        module: 'Admin',
        title: 'System Users',
        urlPattern: '/admin/viewSystemUsers',
        fields: [
          { label: 'Username filter field', type: 'text', locators: ['getByLabel("Username")'], locatorStrategy: 'label', selectorConfidence: 0.9 },
          { label: 'User Role dropdown', type: 'select', locators: ['getByRole("combobox", { name: "User Role" })'], locatorStrategy: 'role', selectorConfidence: 0.86 },
        ],
        buttons: [
          { label: 'Search button', locators: ['getByRole("button", { name: "Search" })'], selectorConfidence: 0.92 },
        ],
      }],
    });

    expect(map.schemaVersion).toBeTruthy();
    expect(map.modules).toContain('Admin');
    expect(map.fields).toHaveLength(2);
    expect(map.fields[0].locators[0]).toContain('Username');
    expect(capabilityMap.summarizeCapabilityMap(map).locatorBackedFields).toBe(2);
  });

  it('flags missing capability map when grounding is required', () => {
    const defects = capabilityMap.collectAppCapabilityDefects([
      { module: 'Admin', cases: [{ id: 'case-1', steps: [{ action: 'Fill', target: 'Username filter field' }] }] },
    ], { requireCapabilityMap: true });

    expect(defects.map((defect) => defect.code)).toContain('missing_app_capability');
  });

  it('flags stale maps and missing required modules', () => {
    const map = capabilityMap.buildAppCapabilityMap({
      projectId: 'orangehrm',
      modules: ['PIM'],
      freshness: 'stale',
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    const defects = capabilityMap.capabilityFreshnessDefects(map, {
      requiredModules: ['Admin'],
      now: new Date('2026-07-04T00:00:00.000Z'),
      maxAgeDays: 14,
    });

    expect(defects.map((defect) => defect.code)).toEqual(expect.arrayContaining([
      'stale_app_capability',
      'missing_app_capability',
    ]));
  });

  it('records calibrationAtlas fallback source honestly', () => {
    const map = capabilityMap.buildAppCapabilityMapFromAtlas({
      projectId: 'orangehrm',
      atlas: {
        stale: true,
        degraded: 'no_authprofile_slice',
        pages: [{
          title: 'System Users',
          url: 'https://opensource-demo.orangehrmlive.com/web/index.php/admin/viewSystemUsers',
          capabilities: [],
        }],
        capabilities: [],
      },
    });
    const summary = capabilityMap.summarizeCapabilityMap(map);

    expect(map.source).toBe('calibration_atlas_fallback');
    expect(map.freshness).toBe('stale');
    expect(map.invalidationReason).toBe('no_authprofile_slice');
    expect(summary.source).toBe('calibration_atlas_fallback');
  });

  it('invalidates capability maps when target URL or auth role changes', () => {
    const map = capabilityMap.buildAppCapabilityMap({
      projectId: 'orangehrm',
      modules: ['Admin'],
      pages: [{
        module: 'Admin',
        title: 'System Users',
        urlPattern: 'https://old.example.test/admin',
        requiresAuthRole: 'ESS',
        fields: [{ label: 'Username filter field', locators: ['getByLabel("Username")'], selectorConfidence: 0.9 }],
      }],
    });
    const defects = capabilityMap.capabilityFreshnessDefects(map, {
      targetUrl: 'https://opensource-demo.orangehrmlive.com/web/index.php/admin/viewSystemUsers',
      authRole: 'ADMIN_DEFAULT',
    });

    expect(defects.filter((defect) => defect.code === 'stale_app_capability')).toHaveLength(2);
    expect(defects.map((defect) => defect.message).join(' ')).toContain('target URL');
    expect(defects.map((defect) => defect.message).join(' ')).toContain('auth role');
  });

  it('blocks Reliable when page/form/menu structure is missing', () => {
    const map = capabilityMap.buildAppCapabilityMap({
      projectId: 'orangehrm',
      modules: ['Admin'],
      pages: [],
      fields: [],
      buttons: [],
    });
    const defects = capabilityMap.capabilityFreshnessDefects(map, { requiredModules: ['Admin'] });

    expect(defects.map((defect) => defect.code)).toContain('missing_app_capability');
    expect(defects.map((defect) => defect.message).join(' ')).toContain('no pages');
    expect(defects.map((defect) => defect.message).join(' ')).toContain('no form/menu/action structure');
  });

  it('grounds generated steps against locator-backed fields and buttons', () => {
    const map = capabilityMap.buildAppCapabilityMap({
      projectId: 'orangehrm',
      modules: ['Admin'],
      pages: [{
        module: 'Admin',
        title: 'System Users',
        fields: [
          { label: 'Username filter field', locators: ['getByLabel("Username")'], selectorConfidence: 0.9 },
          { label: 'User Role dropdown', locators: ['getByRole("combobox", { name: "User Role" })'], selectorConfidence: 0.85 },
        ],
        buttons: [
          { label: 'Search button', locators: ['getByRole("button", { name: "Search" })'], selectorConfidence: 0.91 },
        ],
      }],
    });
    const defects = capabilityMap.collectAppCapabilityDefects([
      {
        name: 'Admin Search',
        module: 'Admin',
        cases: [{
          id: 'admin-case',
          steps: [
            { action: 'Fill', target: 'Username filter field' },
            { action: 'Select', target: 'User Role dropdown' },
            { action: 'Click', target: 'Search button' },
          ],
        }],
      },
    ], { capabilityMap: map });

    expect(defects).toEqual([]);
  });

  it('creates user-decision defects when locator evidence is missing or low-confidence', () => {
    const map = capabilityMap.buildAppCapabilityMap({
      projectId: 'orangehrm',
      modules: ['Claim'],
      pages: [{
        module: 'Claim',
        title: 'Submit Claim',
        fields: [
          { label: 'Event dropdown', locators: [], selectorConfidence: 0 },
          { label: 'Currency dropdown', locators: ['css=.currency'], selectorConfidence: 0.2 },
        ],
      }],
    });
    const defects = capabilityMap.collectAppCapabilityDefects([
      {
        module: 'Claim',
        cases: [{
          id: 'claim-case',
          steps: [
            { action: 'Select', target: 'Event dropdown' },
            { action: 'Select', target: 'Currency dropdown' },
          ],
        }],
      },
    ], { capabilityMap: map, minSelectorConfidence: 0.55 });

    expect(defects).toHaveLength(2);
    expect(defects.every((defect) => defect.severity === 'user_decision_required')).toBe(true);
  });

  it('integrates capability defects into reliability collection and promotion', () => {
    const scenarios = [{
      module: 'Admin',
      cases: [{
        id: 'case-1',
        name: 'Admin Search',
        coverageRefs: ['admin-system-user-search'],
        steps: [
          { action: 'Fill', target: 'Username filter field', value: '{{usernamefilter}}' },
          { action: 'Select', target: 'User Role dropdown', value: '{{userrolefilter}}' },
          { action: 'Fill', target: 'Employee Name filter field', value: '{{employeename}}' },
          { action: 'Select', target: 'Status dropdown', value: '{{statusfilter}}' },
          { action: 'Verify', target: 'Result row', verify: { kind: 'text', text: 'Records Found' } },
        ],
        declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Records Found' } }],
      }],
    }];
    const defects = contracts.collectScenarioReliabilityDefects(scenarios, { capabilityGroundingRequired: true });
    const report = promotion.createScenarioReliabilityReport({
      scenarios,
      defects,
      appCapabilitySummary: { missing_app_capability: 1 },
    });

    expect(defects.map((defect) => defect.code)).toContain('missing_app_capability');
    expect(report.status).toBe('needs_user_decision');
    expect(promotion.canPromoteToReliable(report)).toBe(false);
  });
});
