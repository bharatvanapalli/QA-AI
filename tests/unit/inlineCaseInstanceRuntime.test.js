import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const executableTestContract = require('../../server/services/executableTestContract.js');

describe('inline CaseInstanceV1 runtime identity', () => {
  it('carries exact row revisions and public bindings without persisting a raw secret in the active instance', () => {
    const testCase = {
      id: 'case-inline-runtime',
      name: 'Authenticate inline row',
      generationId: 'generation-inline-v1',
      steps: JSON.stringify([
        { id: 'fill-email', action: 'Fill', element: 'Email', value: 'second@example.test' },
        { id: 'fill-password', action: 'Fill', element: 'Password', value: 'Second-Secret' },
      ]),
      declaredAssertions: JSON.stringify([]),
      qualityContractJson: JSON.stringify({
        caseContractV1: {
          version: 'CaseContractV1',
          id: 'case-contract-inline',
          dataBindings: [
            { id: 'data.email', name: 'email', classification: 'normal' },
            { id: 'data.password', name: 'password', classification: 'sensitive' },
            { id: 'data.access_key', name: 'access_key', classification: 'sensitive' },
          ],
          sessionRequirement: { mode: 'fresh' },
        },
      }),
    };
    const dataRow = {
      index: 1,
      label: 'Row 2',
      setName: 'InlineText',
      fields: {
        email: 'second@example.test',
        password: 'Second-Secret',
        access_key: 'Raw-Access-Key-Must-Not-Escape',
      },
      // This is the exact compatibility shape rebuilt by Conductor today: it
      // preserves fields plus evidenceContract while omitting newer top-level
      // identity keys. executableTestContract must hydrate the active instance.
      evidenceContract: {
        kind: 'inline_case_instance_v1',
        rowId: 'row-002',
        ordinal: 2,
        instancePlanId: 'instance-row-002',
        instanceRevision: 'instance-revision-row-002',
        inlineRevision: 'inline-revision-v1',
        defaultInstanceId: 'instance-row-001',
        publicBindings: {
          email: { kind: 'inline', value: 'second@example.test' },
          password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD_ROW_2' },
          access_key: { kind: 'environment', name: 'QAAI_INLINE_ACCESS_KEY_ROW_2' },
        },
      },
    };

    const contract = executableTestContract.buildExecutionContract({
      testCase,
      dataRow,
      runId: 'run-inline-v1',
    });
    const instance = contract.caseInstanceV1;

    expect(contract.nodes.every((node) => node.dataRowId === 'row-002')).toBe(true);
    expect(contract.dataRow).toMatchObject({
      rowId: 'row-002',
      ordinal: 2,
      instancePlanId: 'instance-row-002',
      instanceRevision: 'instance-revision-row-002',
      inlineRevision: 'inline-revision-v1',
      inlineInstance: true,
    });
    expect(instance).toMatchObject({
      dataRowId: 'row-002',
      dataRowOrdinal: 2,
      instancePlanId: 'instance-row-002',
      instanceRevision: 'instance-revision-row-002',
      inlineRevision: 'inline-revision-v1',
      defaultInstanceId: 'instance-row-001',
      inputs: {
        email: { kind: 'inline', value: 'second@example.test' },
        password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD_ROW_2', sensitive: true },
      },
    });
    expect(instance.inlineData['data.password']).toEqual({
      kind: 'environment',
      name: 'QAAI_INLINE_PASSWORD_ROW_2',
      sensitive: true,
    });
    expect(contract.dataRow.fields.access_key).toEqual({
      kind: 'environment',
      name: 'QAAI_INLINE_ACCESS_KEY_ROW_2',
      sensitive: true,
    });
    expect(JSON.stringify(instance)).not.toContain('Second-Secret');
    expect(JSON.stringify(contract.dataRow)).not.toContain('Raw-Access-Key-Must-Not-Escape');

    const beforeId = instance.id;
    const attached = executableTestContract.attachRunResultId(contract, 'result-inline-row-002');
    expect(attached.runResultId).toBe('result-inline-row-002');
    expect(attached.nodes.every((node) => node.runResultId === 'result-inline-row-002')).toBe(true);
    expect(attached.caseInstanceV1.runResultId).toBe('result-inline-row-002');
    expect(attached.caseInstanceV1.id).not.toBe(beforeId);
  });
});
