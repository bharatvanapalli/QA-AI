const fs = require('fs');
const mcpContextConfig = require('../../server/services/mcpContextConfig');

describe('MCP context evidence recorder', () => {
  test('installs the bounded recorder in the existing per-page init script', () => {
    const context = mcpContextConfig.buildContextArgs(
      { autoAcceptDialogs: false },
      { id: `recorder-test-${Date.now()}` },
    );
    try {
      const source = fs.readFileSync(context.initScriptPath, 'utf8');
      expect(source).toContain('__qaaiEvidenceRecorderV1');
      expect(source).toContain('valueChanged');
      expect(source).not.toContain('target.value');
    } finally {
      mcpContextConfig.cleanupContextArtifacts(context);
    }
  });
});
