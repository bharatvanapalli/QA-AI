import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const taxonomy = require('../../server/services/controllerBrowserMutationTaxonomy');

describe('controller browser mutation taxonomy', () => {
  it('treats all executable browser code as mutation-authorized by default', () => {
    for (const toolName of ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe']) {
      expect(taxonomy.classifyControllerBrowserTool(toolName, {
        function: '() => document.title',
      })).toMatchObject({
        operationClass: taxonomy.OPERATION_CLASS.MUTATION,
        requiresControllerMutationPermit: true,
      });
    }
  });

  it('allows only exact read-only CDP commands into the observation lane', () => {
    expect(taxonomy.classifyControllerBrowserTool('browser_execute_cdp_command', {
      command: 'DOM.describeNode',
    }).operationClass).toBe(taxonomy.OPERATION_CLASS.OBSERVATION);
    expect(taxonomy.classifyControllerBrowserTool('browser_execute_cdp_command', {
      command: 'Network.setCookies',
    }).operationClass).toBe(taxonomy.OPERATION_CLASS.MUTATION);
    expect(taxonomy.classifyControllerBrowserTool('browser_execute_cdp_command', {
      command: 'DOM.describeNodeAndMutate',
    }).operationClass).toBe(taxonomy.OPERATION_CLASS.MUTATION);
  });

  it('rejects unregistered tools and observation tools at the mutation gateway boundary', () => {
    expect(() => taxonomy.assertControllerMutationTool('browser_snapshot')).toThrowError(
      expect.objectContaining({ code: 'CONTROLLER_GATEWAY_OBSERVATION_TOOL_FORBIDDEN' }),
    );
    expect(() => taxonomy.assertControllerMutationTool('browser_magic_click')).toThrowError(
      expect.objectContaining({ code: 'CONTROLLER_GATEWAY_TOOL_UNREGISTERED' }),
    );
  });
});
